import {
  EC2Client,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  RebootInstancesCommand,
  TerminateInstancesCommand,
  DescribeInstancesCommand,
  DescribeImagesCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  DescribeSecurityGroupsCommand,
  DescribeVpcsCommand,
  CreateDefaultVpcCommand,
  ModifyInstanceAttributeCommand,
  DescribeVolumesCommand,
  ModifyVolumeCommand,
  DescribeVolumesModificationsCommand,
  AllocateAddressCommand,
  AssociateAddressCommand,
  DisassociateAddressCommand,
  ReleaseAddressCommand,
  DescribeAddressesCommand,
} from "@aws-sdk/client-ec2";

import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch";
import { IAMClient } from "@aws-sdk/client-iam";
import { SSMClient } from "@aws-sdk/client-ssm";
import { ensureInstanceRole, deleteInstanceRole, runCommand } from "./ec2-ssm";
import type { Provisioner, ProvisionResult, Connection, DiskConfig } from "./provisioner";
import type { Project } from "../db/schema";
import { getProjectSecrets } from "./secrets";
import { decrypt } from "../crypto/secrets";
import { buildStack } from "./stack/compose";
import { thirdPartyJwkKeys } from "./third-party-auth";
import { getCredentials } from "../aws/credentials-service";

// Map the dashboard's compute tier -> a real EC2 instance type. The full supabase
// stack needs ~4GB RAM, so the SMALLEST we ever launch is t3.medium (4GB) — tiers
// below that (micro/small) are filtered out of the dedicated selector in the UI.
// ARM/Graviton instances (t4g/m6g) — these match the dashboard's compute tier labels
// and (real) pricing. The AMI is arm64 to match.
const COMPUTE_SIZE_TO_INSTANCE_TYPE: Record<string, string> = {
  micro: "t4g.medium", // floor — should be filtered in the UI, but never launch <4GB
  small: "t4g.medium",
  medium: "t4g.medium", // 4 GB
  large: "m6g.large", // 8 GB
  xlarge: "m6g.xlarge", // 16 GB
  "2xlarge": "m6g.2xlarge", // 32 GB
  "4xlarge": "m6g.4xlarge", // 64 GB
  "8xlarge": "m6g.8xlarge", // 128 GB
  "12xlarge": "m6g.12xlarge", // 192 GB
  "16xlarge": "m6g.16xlarge", // 256 GB
};
// EC2_INSTANCE_TYPE overrides everything (testing). Otherwise default to medium (4GB).
function instanceTypeFor(computeSize: string | null | undefined): string {
  if (process.env.EC2_INSTANCE_TYPE) return process.env.EC2_INSTANCE_TYPE;
  return COMPUTE_SIZE_TO_INSTANCE_TYPE[computeSize ?? "medium"] ?? "t4g.medium";
}
const SG_NAME = "supabase-console-dedicated";
// [console fork] The self-host stack only works with OUR fork of supabase, not
// upstream. Overridable via env for private forks / pinned branches.
const SUPABASE_FORK_REPO = process.env.SUPABASE_FORK_REPO ?? "https://github.com/notpointless/supabase";
const SUPABASE_FORK_BRANCH = process.env.SUPABASE_FORK_BRANCH ?? "chore/console-fork";
// Ports opened to the instance. Kong API (8000/8443) + Postgres (5432) are the stack's
// public surface; all remote management goes through SSM (see ec2-ssm.ts), so SSH (22) is
// intentionally NOT opened — it'd be pure attack surface. Operators needing a shell use
// SSM Session Manager. NOTE: 5432 is open to 0.0.0.0/0 for direct DB access; operators who
// don't need that should tighten this SG to their own CIDR.
const INGRESS_PORTS = [5432, 8000, 8443];

// [console fork] Grow the root partition + filesystem to fill a just-resized EBS volume. Detects
// the root device (NVMe on Graviton/nitro vs xvd) and fs type (xfs on AL2023 vs ext4) at runtime,
// so it works regardless of instance family. Run over SSM after ModifyVolume.
const GROW_DISK_SCRIPT = `#!/bin/bash
set -e
ROOT_PART=$(findmnt -no SOURCE /)
DISK="/dev/$(lsblk -no pkname "$ROOT_PART")"
PARTNUM=$(echo "$ROOT_PART" | grep -o '[0-9]*$')
growpart "$DISK" "$PARTNUM" || true
FSTYPE=$(findmnt -no FSTYPE /)
if [ "$FSTYPE" = "xfs" ]; then xfs_growfs /; else resize2fs "$ROOT_PART"; fi`;

function clientFor(region: string, creds: { accessKeyId: string; secretAccessKey: string }) {
  return new EC2Client({
    region,
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
  });
}

// IAM is a global service but the SDK still requires a region — us-east-1 hosts the
// global endpoint. SSM is regional.
function iamClientFor(creds: { accessKeyId: string; secretAccessKey: string }) {
  return new IAMClient({
    region: "us-east-1",
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
  });
}
function ssmClientFor(region: string, creds: { accessKeyId: string; secretAccessKey: string }) {
  return new SSMClient({
    region,
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
  });
}

/** Latest Amazon Linux 2023 arm64 AMI in the target region (we launch ARM/Graviton
 *  instances — t4g/m6g — which the dashboard's compute tiers + pricing reflect). */
async function latestAl2023Ami(ec2: EC2Client): Promise<string> {
  const out = await ec2.send(
    new DescribeImagesCommand({
      Owners: ["amazon"],
      Filters: [
        { Name: "name", Values: ["al2023-ami-2023.*-arm64"] },
        { Name: "state", Values: ["available"] },
        { Name: "architecture", Values: ["arm64"] },
      ],
    })
  );
  const images = (out.Images ?? []).sort((a, b) =>
    (b.CreationDate ?? "").localeCompare(a.CreationDate ?? "")
  );
  if (!images[0]?.ImageId) throw new Error("Could not resolve an Amazon Linux 2023 AMI");
  return images[0].ImageId;
}

/** Ensure a security group exists in the default VPC and return its id. */
// Many AWS accounts (especially hardened/Organizations ones) have no default VPC.
// Our launch uses the default VPC implicitly (SecurityGroupIds, no subnet), so create
// one when it's missing — CreateDefaultVpc brings the VPC + public subnets + IGW + routes.
async function ensureDefaultVpc(ec2: EC2Client): Promise<void> {
  const existing = await ec2.send(
    new DescribeVpcsCommand({ Filters: [{ Name: "isDefault", Values: ["true"] }] })
  );
  if (existing.Vpcs && existing.Vpcs.length > 0) return;
  try {
    await ec2.send(new CreateDefaultVpcCommand({}));
  } catch (e) {
    const err = e as { name?: string; message?: string };
    if (err?.name === "DefaultVpcAlreadyExists") return;
    if (err?.name === "UnauthorizedOperation" || /not authorized/i.test(err?.message ?? "")) {
      throw new Error(
        "This AWS account has no default VPC and the credentials lack ec2:CreateDefaultVpc. " +
          "Grant that permission (or create a default VPC) so dedicated projects can launch."
      );
    }
    throw e;
  }
}

async function ensureSecurityGroup(ec2: EC2Client): Promise<string> {
  const existing = await ec2.send(
    new DescribeSecurityGroupsCommand({ Filters: [{ Name: "group-name", Values: [SG_NAME] }] })
  );
  if (existing.SecurityGroups?.[0]?.GroupId) return existing.SecurityGroups[0].GroupId;

  const created = await ec2.send(
    new CreateSecurityGroupCommand({
      GroupName: SG_NAME,
      Description: "Supabase Console dedicated project (Kong, Postgres, SSH)",
    })
  );
  const groupId = created.GroupId!;
  await ec2.send(
    new AuthorizeSecurityGroupIngressCommand({
      GroupId: groupId,
      IpPermissions: INGRESS_PORTS.map((p) => ({
        IpProtocol: "tcp",
        FromPort: p,
        ToPort: p,
        IpRanges: [{ CidrIp: "0.0.0.0/0" }],
      })),
    })
  );
  return groupId;
}

/**
 * cloud-init user-data: installs Docker, pulls the official Supabase self-hosting
 * compose, writes our secrets into its .env, and brings the stack up on the host.
 * This makes a dedicated project a real server, not a container on our control plane.
 */
function userData(env: Record<string, string>): string {
  const envLines = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const envB64 = Buffer.from(envLines, "utf8").toString("base64");
  const script = `#!/bin/bash
set -euxo pipefail
SUPABASE_FORK_REPO="${SUPABASE_FORK_REPO}"
SUPABASE_FORK_BRANCH="${SUPABASE_FORK_BRANCH}"
dnf install -y docker git || yum install -y docker git
systemctl enable --now docker
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-aarch64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
# [console fork] Use OUR fork of supabase (notpointless/supabase) — the self-host
# stack only works with our console-fork customizations, not upstream.
git clone --depth 1 --branch "${SUPABASE_FORK_BRANCH}" "${SUPABASE_FORK_REPO}" /opt/supabase
cd /opt/supabase/docker
cp .env.example .env
# Override defaults with our project secrets (later duplicate keys win in compose).
echo "" >> .env
echo "${envB64}" | base64 -d >> .env
# Point public URLs at this instance's public IP.
IP=$(curl -fsS http://169.254.169.254/latest/meta-data/public-ipv4 || echo localhost)
{
  echo "API_EXTERNAL_URL=http://$IP:8000"
  echo "SUPABASE_PUBLIC_URL=http://$IP:8000"
  echo "SITE_URL=http://$IP:8000"
} >> .env
# Include the logs overlay so the analytics (Logflare) + vector services start — they back the
# dashboard's report/log graphs. DOCKER_SOCKET_LOCATION + LOGFLARE_* tokens come from buildStack's env.
docker compose -f docker-compose.yml -f docker-compose.logs.yml up -d

# [console fork] A dedicated instance is the project's own box, so tune Postgres to
# use its full RAM/CPU (the image ships conservative defaults: shared_buffers=128MB,
# max_connections=100). Standard formulas (25%/75% RAM); applied via ALTER SYSTEM +
# a db restart. Defensive (|| true) so tuning can never block provisioning.
(
  sleep 45
  TOTAL_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
  CPUS=$(nproc)
  SHARED_MB=$((TOTAL_MB / 4))
  CACHE_MB=$((TOTAL_MB * 3 / 4))
  MAINT_MB=$((TOTAL_MB / 16))
  [ "$MAINT_MB" -gt 2048 ] && MAINT_MB=2048
  docker exec supabase-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=0 -c "
    ALTER SYSTEM SET shared_buffers='\${SHARED_MB}MB';
    ALTER SYSTEM SET effective_cache_size='\${CACHE_MB}MB';
    ALTER SYSTEM SET maintenance_work_mem='\${MAINT_MB}MB';
    ALTER SYSTEM SET max_connections='200';
    ALTER SYSTEM SET max_worker_processes='\${CPUS}';
    ALTER SYSTEM SET max_parallel_workers='\${CPUS}';
    ALTER SYSTEM SET max_parallel_workers_per_gather='\$(( (CPUS+1)/2 ))';
  " && docker restart supabase-db
) >/var/log/pg-tune.log 2>&1 || true
`;
  return Buffer.from(script, "utf8").toString("base64");
}

function instanceIdOf(project: Project): string {
  const conn = (project.connection ?? {}) as Connection & { instanceId?: string };
  const id = conn.instanceId;
  if (!id) throw new Error(`No EC2 instance recorded for project ${project.ref}`);
  return id;
}

// [console fork] Iceberg analytics buckets are an AWS-only capability: storage's Iceberg
// catalog proxies AWS S3 Tables (sigv4, signed by the instance role's s3tables policy).
// Dedicated instances get it enabled with their region's catalog endpoint.
function applyIcebergEnv(env: Record<string, string>, region: string | null | undefined): void {
  env.ICEBERG_ENABLED = "true";
  env.ICEBERG_CATALOG_URL = `https://s3tables.${region ?? "us-east-1"}.amazonaws.com/iceberg/v1`;
}

export class Ec2Provisioner implements Provisioner {
  async provision(project: Project): Promise<ProvisionResult> {
    const secrets = await getProjectSecrets(project.id);
    if (!secrets) throw new Error(`No secrets for project ${project.ref}`);
    const creds = await getCredentials(project.organizationId);
    const ec2 = clientFor(project.region, creds);

    // Build the stack env (fixed self-hosting ports; URLs are finalised on the box).
    const { env } = await buildStack({
      project: { ref: project.ref, name: project.name },
      secrets,
      dbPassword: decrypt(project.dbPasswordEncrypted),
      ports: { kongHttp: 8000, kongHttps: 8443, db: 5432 },
      urls: {
        apiExternalUrl: "http://__PUBLIC_HOST__:8000",
        siteUrl: "http://__PUBLIC_HOST__:8000",
        supabasePublicUrl: "http://__PUBLIC_HOST__:8000",
      },
      dataApiEnabled: project.dataApiEnabled,
      authConfig: project.authConfig as Record<string, unknown> | null,
      thirdPartyJwks: thirdPartyJwkKeys(project),
      storageConfig: project.storageConfig as { fileSizeLimit?: number } | null,
    });
    applyIcebergEnv(env, project.region);

    await ensureDefaultVpc(ec2);
    // Per-instance IAM role/profile (SSM remote-exec). Torn down on delete + rollback.
    const iam = iamClientFor(creds);
    const [imageId, groupId, profileName] = await Promise.all([
      latestAl2023Ami(ec2),
      ensureSecurityGroup(ec2),
      ensureInstanceRole(iam, project.ref),
    ]);

    const runCmd = new RunInstancesCommand({
      ImageId: imageId,
      InstanceType: instanceTypeFor(project.computeSize) as any,
      MinCount: 1,
      MaxCount: 1,
      SecurityGroupIds: [groupId],
      IamInstanceProfile: { Name: profileName },
      UserData: userData(env),
      BlockDeviceMappings: [
        { DeviceName: "/dev/xvda", Ebs: { VolumeSize: 30, VolumeType: "gp3", DeleteOnTermination: true } },
      ],
      TagSpecifications: [
        {
          ResourceType: "instance",
          Tags: [
            { Key: "Name", Value: `supabase-${project.ref}` },
            { Key: "supabase:project-ref", Value: project.ref },
            { Key: "supabase:managed-by", Value: "supabase-console" },
          ],
        },
      ],
    });
    // A just-created instance profile isn't usable by RunInstances for a few seconds
    // (IAM propagation). Retry on the invalid-profile error. If the launch never
    // succeeds, the role is cleaned up by the task rollback -> delete().
    let run;
    for (let i = 0; i < 12; i++) {
      try {
        run = await ec2.send(runCmd);
        break;
      } catch (e) {
        const msg = (e as { message?: string })?.message ?? "";
        if (/Invalid IAM Instance Profile|instance profile/i.test(msg) && i < 11) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        throw e;
      }
    }
    if (!run) throw new Error("EC2 RunInstances did not return");

    const instanceId = run.Instances?.[0]?.InstanceId;
    if (!instanceId) throw new Error("EC2 did not return an instance id");

    // Self-clean on any post-launch failure: the connection (with instanceId) isn't
    // persisted until we return, so the provision-task rollback can't see the instance
    // to terminate it. Terminate here so a failed provision never leaves an orphan.
    let allocationId: string | undefined;
    try {
      // [console fork] Allocate + associate an Elastic IP so the public IP is STABLE across
      // stop/start. Without it, pause/resume (and resize) hand the instance a NEW IP, which
      // breaks the stack's own .env URLs, any custom hostname (the CNAME target), and saved
      // connection strings. Associate ASAP (retry while pending) so the boot-time user-data
      // resolves the EIP, not the ephemeral auto-assigned IP. Tagged so delete can reclaim it.
      const eip = await ec2.send(
        new AllocateAddressCommand({
          Domain: "vpc",
          TagSpecifications: [
            {
              ResourceType: "elastic-ip",
              Tags: [
                { Key: "supabase:project-ref", Value: project.ref },
                { Key: "supabase:managed-by", Value: "supabase-console" },
              ],
            },
          ],
        })
      );
      allocationId = eip.AllocationId;
      const host = eip.PublicIp;
      if (!allocationId || !host) throw new Error("EC2 did not return an Elastic IP");
      for (let i = 0; i < 15; i++) {
        try {
          await ec2.send(new AssociateAddressCommand({ InstanceId: instanceId, AllocationId: allocationId }));
          break;
        } catch (e) {
          if (i < 14) {
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          throw e;
        }
      }
      // Don't return (and let the project flip to "active") until the data plane (kong)
      // actually responds — otherwise the dashboard lets the user in while the stack is
      // still pulling images and every data-plane call errors.
      await this.waitForStack(host);
      const apiUrl = `http://${host}:8000`;
      return {
        connection: {
          host,
          apiUrl,
          kongHttpPort: 8000,
          kongHttpsPort: 8443,
          dbPort: 5432,
          ref: project.ref,
          // persisted in project.connection (jsonb) for lifecycle ops
          instanceId,
          allocationId,
          region: project.region,
        } as Connection & { instanceId: string; region: string },
      };
    } catch (e) {
      await this.terminateWithRetry(ec2, instanceId).catch(() => {});
      if (allocationId) {
        await ec2.send(new ReleaseAddressCommand({ AllocationId: allocationId })).catch(() => {});
      }
      await deleteInstanceRole(iam, project.ref).catch(() => {});
      // [console fork] Each dedicated project takes one Elastic IP (for a stable public IP
      // across stop/start); AWS caps these at 5/region by default. Surface a clear, actionable
      // message instead of the raw SDK error so the operator knows to request a limit increase.
      const name = (e as { name?: string })?.name ?? "";
      if (name === "AddressLimitExceeded" || /AddressLimitExceeded/.test(String((e as { message?: string })?.message ?? ""))) {
        throw new Error(
          "AWS Elastic IP limit reached (default 5 per region). Each dedicated project needs one " +
            "for a stable IP across pause/resume — request an EC2 Elastic IP limit increase to launch more."
        );
      }
      throw e;
    }
  }

  // Terminate an instance, tolerating eventual consistency right after launch.
  private async terminateWithRetry(ec2: EC2Client, instanceId: string): Promise<void> {
    for (let i = 0; i < 18; i++) {
      try {
        await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
        return;
      } catch (e) {
        if ((e as { name?: string })?.name === "InvalidInstanceID.NotFound" && i < 17) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        throw e;
      }
    }
  }

  private async waitForPublicHost(ec2: EC2Client, instanceId: string): Promise<string> {
    for (let i = 0; i < 60; i++) {
      try {
        const out = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
        const inst = out.Reservations?.[0]?.Instances?.[0];
        const host = inst?.PublicDnsName || inst?.PublicIpAddress;
        if (host && inst?.State?.Name === "running") return host;
      } catch (e) {
        // AWS eventual consistency: a just-launched instance ID isn't queryable for a
        // few seconds. Tolerate NotFound and keep polling instead of failing provision.
        if ((e as { name?: string })?.name !== "InvalidInstanceID.NotFound") throw e;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error(`EC2 instance ${instanceId} did not become reachable in time`);
  }

  // Poll kong (the data plane) until it responds, so the project isn't marked active
  // until it's actually usable. Best-effort: after ~15 min we give up waiting and let
  // the project go active anyway (the stack is likely just slow, not broken).
  private async waitForStack(host: string): Promise<void> {
    for (let i = 0; i < 180; i++) {
      try {
        const res = await fetch(`http://${host}:8000/`, { signal: AbortSignal.timeout(5000) });
        // Any HTTP response means kong is up (401 without an apikey is expected).
        if (res.status > 0) return;
      } catch {
        // connection refused / timeout — stack still coming up
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  async pause(project: Project): Promise<void> {
    const creds = await getCredentials(project.organizationId);
    const ec2 = clientFor(project.region, creds);
    await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceIdOf(project)] }));
  }

  async resume(project: Project): Promise<Connection> {
    const creds = await getCredentials(project.organizationId);
    const ec2 = clientFor(project.region, creds);
    const instanceId = instanceIdOf(project);
    await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
    // [console fork] The public host changes on stop/start, so capture + return the fresh
    // connection to persist — otherwise the project (and its internal-config endpoint) point
    // at the dead host after a pause/resume.
    const host = await this.waitForPublicHost(ec2, instanceId);
    // [console fork] The instance's public IP also changed, so the stack's own .env
    // (API_EXTERNAL_URL / SITE_URL / SUPABASE_PUBLIC_URL) is now stale — GoTrue redirects,
    // email links and the API external URL would point at the dead IP. Re-apply the stack so it
    // re-resolves the new IP (and picks up any config edited while paused). Best-effort: the
    // instance is up regardless, and a stale .env can be fixed by a later reconfigure.
    try {
      await this.reconfigure(project);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[ec2 resume] reconfigure failed for ${project.ref}:`, e instanceof Error ? e.message : e);
    }
    return {
      host,
      apiUrl: `http://${host}:8000`,
      kongHttpPort: 8000,
      kongHttpsPort: 8443,
      dbPort: 5432,
      ref: project.ref,
      instanceId,
      region: project.region,
    } as Connection & { instanceId: string; region: string };
  }

  // Dedicated instances reboot the whole box (the stack auto-starts via
  // restart:unless-stopped); per-service restart isn't available over the EC2 API.
  async restart(project: Project): Promise<void> {
    const creds = await getCredentials(project.organizationId);
    const ec2 = clientFor(project.region, creds);
    await ec2.send(new RebootInstancesCommand({ InstanceIds: [instanceIdOf(project)] }));
  }

  // [console fork] EC2 twin of the shared `reconfigure`: regenerate the stack env and re-apply
  // it on the dedicated box over SSM (rewrite /opt/supabase/docker/.env from the fork defaults +
  // our env + the instance's public URLs, then `compose up -d` to recreate changed containers).
  // This is what lets config changes (e.g. auth/OAuth toggles, the JWT-keys fix) reach dedicated
  // projects — without it, EC2 projects could only be rebooted, never reconfigured.
  async reconfigure(project: Project): Promise<void> {
    const secrets = await getProjectSecrets(project.id);
    if (!secrets) throw new Error(`No secrets for project ${project.ref}`);
    const creds = await getCredentials(project.organizationId);
    const ssm = ssmClientFor(project.region, creds);
    const { env } = await buildStack({
      project: { ref: project.ref, name: project.name },
      secrets,
      dbPassword: decrypt(project.dbPasswordEncrypted),
      ports: { kongHttp: 8000, kongHttps: 8443, db: 5432 },
      urls: {
        apiExternalUrl: "http://__PUBLIC_HOST__:8000",
        siteUrl: "http://__PUBLIC_HOST__:8000",
        supabasePublicUrl: "http://__PUBLIC_HOST__:8000",
      },
      dataApiEnabled: project.dataApiEnabled,
      authConfig: project.authConfig as Record<string, unknown> | null,
      thirdPartyJwks: thirdPartyJwkKeys(project),
      storageConfig: project.storageConfig as { fileSizeLimit?: number } | null,
    });
    applyIcebergEnv(env, project.region);
    const envLines = Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    const envB64 = Buffer.from(envLines, "utf8").toString("base64");
    const script = `#!/bin/bash
set -euxo pipefail
cd /opt/supabase/docker
cp .env.example .env
echo "" >> .env
echo "${envB64}" | base64 -d >> .env
IP=$(curl -fsS http://169.254.169.254/latest/meta-data/public-ipv4 || echo localhost)
{
  echo "API_EXTERNAL_URL=http://$IP:8000"
  echo "SUPABASE_PUBLIC_URL=http://$IP:8000"
  echo "SITE_URL=http://$IP:8000"
} >> .env
docker compose -f docker-compose.yml -f docker-compose.logs.yml up -d`;
    await runCommand(ssm, instanceIdOf(project), script);
  }

  // Change compute: stop -> change instance type (requires stopped) -> start. The
  // public host changes on stop/start, so return the fresh connection to persist.
  async resize(project: Project): Promise<Connection> {
    const creds = await getCredentials(project.organizationId);
    const ec2 = clientFor(project.region, creds);
    const instanceId = instanceIdOf(project);
    const instanceType = instanceTypeFor(project.computeSize);
    await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
    await this.waitForState(ec2, instanceId, "stopped");
    await ec2.send(
      new ModifyInstanceAttributeCommand({ InstanceId: instanceId, InstanceType: { Value: instanceType } })
    );
    await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
    const host = await this.waitForPublicHost(ec2, instanceId);
    // [console fork] Compute resize stops/starts the instance, so the public IP changed — like
    // resume, re-apply the stack so its .env points at the new host instead of the dead one.
    try {
      await this.reconfigure(project);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[ec2 resize] reconfigure failed for ${project.ref}:`, e instanceof Error ? e.message : e);
    }
    return {
      host,
      apiUrl: `http://${host}:8000`,
      kongHttpPort: 8000,
      kongHttpsPort: 8443,
      dbPort: 5432,
      ref: project.ref,
      instanceId,
      region: project.region,
    } as Connection & { instanceId: string; region: string };
  }

  private async waitForState(ec2: EC2Client, instanceId: string, state: string): Promise<void> {
    for (let i = 0; i < 60; i++) {
      const out = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
      if (out.Reservations?.[0]?.Instances?.[0]?.State?.Name === state) return;
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error(`EC2 instance ${instanceId} did not reach ${state} in time`);
  }

  // --- Disk (root EBS volume) ---
  private async rootVolumeId(ec2: EC2Client, instanceId: string): Promise<string> {
    const out = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const inst = out.Reservations?.[0]?.Instances?.[0];
    const root =
      inst?.BlockDeviceMappings?.find((b) => b.DeviceName === inst?.RootDeviceName) ??
      inst?.BlockDeviceMappings?.[0];
    const volId = root?.Ebs?.VolumeId;
    if (!volId) throw new Error("Could not resolve the instance's root EBS volume");
    return volId;
  }

  async getDiskConfig(project: Project): Promise<DiskConfig> {
    const creds = await getCredentials(project.organizationId);
    const ec2 = clientFor(project.region, creds);
    const volId = await this.rootVolumeId(ec2, instanceIdOf(project));
    const out = await ec2.send(new DescribeVolumesCommand({ VolumeIds: [volId] }));
    const v = out.Volumes?.[0];
    return {
      sizeGb: v?.Size ?? 8,
      iops: v?.Iops ?? 3000,
      throughput: v?.Throughput ?? 125,
      type: v?.VolumeType ?? "gp3",
    };
  }

  async resizeDisk(project: Project, cfg: DiskConfig): Promise<void> {
    const creds = await getCredentials(project.organizationId);
    const ec2 = clientFor(project.region, creds);
    const volId = await this.rootVolumeId(ec2, instanceIdOf(project));
    // ModifyVolume is an online operation (no stop needed). IOPS/throughput apply to
    // gp3/io1/io2 only; throughput is gp3-only.
    const supportsIops = cfg.type === "gp3" || cfg.type === "io1" || cfg.type === "io2";
    await ec2.send(
      new ModifyVolumeCommand({
        VolumeId: volId,
        Size: cfg.sizeGb,
        VolumeType: cfg.type as DiskConfig["type"] as never,
        Iops: supportsIops ? cfg.iops : undefined,
        Throughput: cfg.type === "gp3" ? cfg.throughput : undefined,
      })
    );
    // [console fork] ModifyVolume grows the EBS volume but NOT the OS partition/filesystem, so
    // the extra space would be unusable. Wait for the modification to apply, then grow the root
    // partition + filesystem on the instance over SSM (device + fs-type detected at runtime).
    // Best-effort — the volume IS larger regardless; an operator can finish the grow manually.
    await this.waitForVolumeModification(ec2, volId);
    try {
      const ssm = ssmClientFor(project.region, creds);
      await runCommand(ssm, instanceIdOf(project), GROW_DISK_SCRIPT);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[ec2 resizeDisk] filesystem grow failed for ${project.ref}:`, e instanceof Error ? e.message : e);
    }
  }

  // Poll until an EBS volume modification has applied (reaches optimizing/completed) so the OS
  // sees the new size before we grow the partition.
  private async waitForVolumeModification(ec2: EC2Client, volumeId: string): Promise<void> {
    for (let i = 0; i < 40; i++) {
      const out = await ec2.send(new DescribeVolumesModificationsCommand({ VolumeIds: [volumeId] }));
      const state = out.VolumesModifications?.[0]?.ModificationState;
      if (!state || state === "optimizing" || state === "completed") return;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // --- Metrics (CloudWatch) ---
  // CPU comes from CloudWatch's built-in AWS/EC2 CPUUtilization — EC2 reports it
  // automatically, so NOTHING is created here (no agent, no IAM role, no alarms) and
  // there is nothing to tear down. RAM/disk would require the CloudWatch agent + an
  // instance IAM role and are left at 0 until that (separately torn down) is added.
  async getMetrics(
    project: Project
  ): Promise<{ cpuPercent: number; ramUsed: number; ramTotal: number; diskUsed: number; diskSize: number }> {
    const creds = await getCredentials(project.organizationId);
    const cw = new CloudWatchClient({
      region: project.region,
      credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
    });
    const now = Date.now();
    let cpuPercent = 0;
    try {
      const out = await cw.send(
        new GetMetricStatisticsCommand({
          Namespace: "AWS/EC2",
          MetricName: "CPUUtilization",
          Dimensions: [{ Name: "InstanceId", Value: instanceIdOf(project) }],
          StartTime: new Date(now - 30 * 60 * 1000),
          EndTime: new Date(now),
          Period: 300,
          Statistics: ["Average"],
        })
      );
      const points = (out.Datapoints ?? []).sort(
        (a, b) => (a.Timestamp?.getTime() ?? 0) - (b.Timestamp?.getTime() ?? 0)
      );
      cpuPercent = Math.round((points.at(-1)?.Average ?? 0) * 10) / 10;
    } catch {
      // metric not available yet (instance just launched) — report 0
    }
    // RAM + disk come from the instance itself via SSM (no CloudWatch agent needed).
    // Best-effort: if the SSM agent hasn't registered yet, leave them at 0.
    let ramUsed = 0,
      ramTotal = 0,
      diskUsed = 0,
      diskSize = 0;
    try {
      const ssm = ssmClientFor(project.region, creds);
      const out = await runCommand(
        ssm,
        instanceIdOf(project),
        "free -b | awk '/Mem:/{print \"mem\", $2, $3}'; df -B1 / | tail -1 | awk '{print \"disk\", $2, $3}'"
      );
      for (const line of out.split("\n")) {
        const [k, a, b] = line.trim().split(/\s+/);
        if (k === "mem") {
          ramTotal = Number(a) || 0;
          ramUsed = Number(b) || 0;
        } else if (k === "disk") {
          diskSize = Number(a) || 0;
          diskUsed = Number(b) || 0;
        }
      }
    } catch {
      // SSM agent not registered yet / command failed — RAM/disk stay 0
    }
    return { cpuPercent, ramUsed, ramTotal, diskUsed, diskSize };
  }

  async delete(project: Project): Promise<void> {
    const creds = await getCredentials(project.organizationId);
    const ec2 = clientFor(project.region, creds);
    // Terminate the instance AND tear down the per-instance IAM role — never orphan
    // either. The connection (with instanceId) is only persisted once provision returns,
    // so a project deleted WHILE STILL PROVISIONING has no recorded instanceId — fall
    // back to finding the instance by its project-ref tag.
    let instanceId = (project.connection as { instanceId?: string } | null)?.instanceId;
    if (!instanceId) {
      const out = await ec2.send(
        new DescribeInstancesCommand({
          Filters: [
            { Name: "tag:supabase:project-ref", Values: [project.ref] },
            { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
          ],
        })
      );
      instanceId = out.Reservations?.[0]?.Instances?.[0]?.InstanceId;
    }
    if (instanceId) await this.terminateWithRetry(ec2, instanceId);
    // [console fork] Release the project's Elastic IP so it doesn't leak (and keep billing).
    // Find it by the project-ref tag (robust even if connection.allocationId was dropped on a
    // resume); disassociate then release. Best-effort — never block the delete.
    try {
      const addrs = await ec2.send(
        new DescribeAddressesCommand({ Filters: [{ Name: "tag:supabase:project-ref", Values: [project.ref] }] })
      );
      for (const addr of addrs.Addresses ?? []) {
        if (addr.AssociationId) {
          await ec2.send(new DisassociateAddressCommand({ AssociationId: addr.AssociationId })).catch(() => {});
        }
        if (addr.AllocationId) {
          await ec2.send(new ReleaseAddressCommand({ AllocationId: addr.AllocationId })).catch(() => {});
        }
      }
    } catch {
      // best-effort EIP cleanup
    }
    // [console fork] Delete the project's EBS snapshots (physical backups) so they don't
    // keep billing after the project is gone. Best-effort — never block the delete.
    try {
      const { deleteAllPhysicalBackups } = await import("./physical-backups.js");
      await deleteAllPhysicalBackups(project);
    } catch {
      // best-effort snapshot cleanup
    }
    await deleteInstanceRole(iamClientFor(creds), project.ref);
  }
}
