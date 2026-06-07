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
} from "@aws-sdk/client-ec2";

import type { Provisioner, ProvisionResult, Connection } from "./provisioner";
import type { Project } from "../db/schema";
import { getProjectSecrets } from "./secrets";
import { decrypt } from "../crypto/secrets";
import { buildStack } from "./stack/compose";
import { getCredentials } from "../aws/credentials-service";

// Default instance type for a dedicated project (compute size is not yet persisted
// per-project; t3.large comfortably runs the full self-hosting stack).
const DEFAULT_INSTANCE_TYPE = "t3.large";
const SG_NAME = "supabase-console-dedicated";
// [console fork] The self-host stack only works with OUR fork of supabase, not
// upstream. Overridable via env for private forks / pinned branches.
const SUPABASE_FORK_REPO = process.env.SUPABASE_FORK_REPO ?? "https://github.com/notpointless/supabase";
const SUPABASE_FORK_BRANCH = process.env.SUPABASE_FORK_BRANCH ?? "chore/console-fork";
// Ports the Supabase self-hosting stack exposes via Kong, plus Postgres + SSH.
const INGRESS_PORTS = [22, 5432, 8000, 8443];

function clientFor(region: string, creds: { accessKeyId: string; secretAccessKey: string }) {
  return new EC2Client({
    region,
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
  });
}

/** Latest Amazon Linux 2023 x86_64 AMI in the target region. */
async function latestAl2023Ami(ec2: EC2Client): Promise<string> {
  const out = await ec2.send(
    new DescribeImagesCommand({
      Owners: ["amazon"],
      Filters: [
        { Name: "name", Values: ["al2023-ami-2023.*-x86_64"] },
        { Name: "state", Values: ["available"] },
        { Name: "architecture", Values: ["x86_64"] },
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
curl -fsSL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
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
docker compose up -d
`;
  return Buffer.from(script, "utf8").toString("base64");
}

function instanceIdOf(project: Project): string {
  const conn = (project.connection ?? {}) as Connection & { instanceId?: string };
  const id = conn.instanceId;
  if (!id) throw new Error(`No EC2 instance recorded for project ${project.ref}`);
  return id;
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
    });

    const [imageId, groupId] = await Promise.all([latestAl2023Ami(ec2), ensureSecurityGroup(ec2)]);

    const run = await ec2.send(
      new RunInstancesCommand({
        ImageId: imageId,
        InstanceType: DEFAULT_INSTANCE_TYPE as any,
        MinCount: 1,
        MaxCount: 1,
        SecurityGroupIds: [groupId],
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
      })
    );

    const instanceId = run.Instances?.[0]?.InstanceId;
    if (!instanceId) throw new Error("EC2 did not return an instance id");

    const host = await this.waitForPublicHost(ec2, instanceId);
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
        region: project.region,
      } as Connection & { instanceId: string; region: string },
    };
  }

  private async waitForPublicHost(ec2: EC2Client, instanceId: string): Promise<string> {
    for (let i = 0; i < 60; i++) {
      const out = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
      const inst = out.Reservations?.[0]?.Instances?.[0];
      const host = inst?.PublicDnsName || inst?.PublicIpAddress;
      if (host && inst?.State?.Name === "running") return host;
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error(`EC2 instance ${instanceId} did not become reachable in time`);
  }

  async pause(project: Project): Promise<void> {
    const creds = await getCredentials(project.organizationId);
    const ec2 = clientFor(project.region, creds);
    await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceIdOf(project)] }));
  }

  async resume(project: Project): Promise<void> {
    const creds = await getCredentials(project.organizationId);
    const ec2 = clientFor(project.region, creds);
    await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceIdOf(project)] }));
  }

  // Dedicated instances reboot the whole box (the stack auto-starts via
  // restart:unless-stopped); per-service restart isn't available over the EC2 API.
  async restart(project: Project): Promise<void> {
    const creds = await getCredentials(project.organizationId);
    const ec2 = clientFor(project.region, creds);
    await ec2.send(new RebootInstancesCommand({ InstanceIds: [instanceIdOf(project)] }));
  }

  async delete(project: Project): Promise<void> {
    const creds = await getCredentials(project.organizationId);
    const ec2 = clientFor(project.region, creds);
    await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceIdOf(project)] }));
  }
}
