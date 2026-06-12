// [console fork] Custom hostname (a.k.a. custom domain) — DEDICATED (EC2) ONLY.
//
// Self-host flow (mirrors the Supabase/Cloudflare custom-hostname UI shape):
//   1. initialize(hostname)  -> store it; return the DNS record to add (an A record
//      pointing the hostname at the instance's public IP). status = pending_validation.
//   2. reverify()            -> resolve the hostname; if it points at the instance IP,
//      status = pending_deployment (ready to activate), else pending_validation + errors.
//   3. activate()            -> open 80/443 on the SG + enable Caddy on the instance
//      (PROXY_DOMAIN=hostname) so it terminates TLS (Let's Encrypt) in front of kong.
//      status = active.
//   4. get() / delete().
import { promises as dns } from "node:dns";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
  AuthorizeSecurityGroupIngressCommand,
} from "@aws-sdk/client-ec2";
import { SSMClient } from "@aws-sdk/client-ssm";
import { db } from "../db/client";
import { project as projectTable, type Project } from "../db/schema";
import { AppError } from "../http/error";
import { getCredentials } from "../aws/credentials-service";
import { runCommand } from "./ec2-ssm";

const SG_NAME = "supabase-console-dedicated";

export interface CustomHostnameState {
  hostname: string;
  status: "pending_validation" | "pending_deployment" | "active";
  sslStatus: "pending_validation" | "pending_deployment" | "active";
  originIp?: string;
  originHost?: string; // the instance's public DNS — the CNAME target shown in the UI
  txtValue?: string; // ownership token shown as the TXT record
  createdAt: string;
}

function ensureDedicated(p: Project): void {
  if (p.infrastructureType === "shared") {
    throw new AppError(
      400,
      "custom_hostname_not_allowed",
      "not allowed to set up custom domain — only available on dedicated (EC2) projects"
    );
  }
}

function ec2For(p: Project) {
  return (async () => {
    const creds = await getCredentials(p.organizationId);
    return {
      ec2: new EC2Client({
        region: p.region,
        credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
      }),
      ssm: new SSMClient({
        region: p.region,
        credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
      }),
      creds,
    };
  })();
}

function instanceIdOf(p: Project): string {
  const id = (p.connection as { instanceId?: string } | null)?.instanceId;
  if (!id) throw new AppError(400, "no_instance", "Project has no running instance yet");
  return id;
}

async function publicIp(p: Project, ec2: EC2Client): Promise<string> {
  const out = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceIdOf(p)] }));
  const ip = out.Reservations?.[0]?.Instances?.[0]?.PublicIpAddress;
  if (!ip) throw new AppError(400, "no_public_ip", "Instance has no public IP yet");
  return ip;
}

// Shape the studio's custom-domains UI expects (Cloudflare custom-hostname response).
// The verify step shows: a CNAME (hostname -> the project endpoint) when
// verification_errors carries the CNAME hint, plus a TXT ownership record. `txt_name`
// must be non-empty or the UI treats it as "still validating" and disables Verify.
function toResponse(s: CustomHostnameState) {
  const pending = s.status === "pending_validation";
  return {
    id: s.hostname,
    status: s.status,
    hostname: s.hostname,
    created_at: s.createdAt,
    custom_metadata: {},
    custom_origin_server: s.originHost ?? s.originIp ?? "",
    // While pending, prompt the CNAME record (the UI renders its value from the project's
    // own endpoint, which for EC2 is the instance host).
    verification_errors: pending ? ["custom hostname does not CNAME to this zone."] : [],
    ownership_verification: s.originHost
      ? { type: "CNAME", name: s.hostname, value: s.originHost }
      : undefined,
    ssl: {
      id: s.hostname,
      type: "dv",
      method: "http",
      status: s.sslStatus,
      txt_name: `_acme-challenge.${s.hostname}`,
      txt_value: s.txtValue ?? "",
      settings: { http2: "on", tls_1_3: "on", min_tls_version: "1.2" },
      wildcard: false,
      bundle_method: "ubiquitous",
      certificate_authority: "lets_encrypt",
      validation_records: s.txtValue
        ? [{ status: s.status, txt_name: `_acme-challenge.${s.hostname}`, txt_value: s.txtValue }]
        : [],
      validation_errors: [] as { message: string }[],
    } as Record<string, unknown>,
  };
}

// The Custom Domains UI is a step machine; it switches on this wrapper `status`:
//   2_initiated            -> show the DNS records to add (CustomDomainVerify)
//   4_origin_setup_completed -> ready to activate (CustomDomainActivate)
//   5_services_reconfigured  -> active (CustomDomainDelete)
function stepStatus(s: CustomHostnameState): string {
  if (s.status === "active") return "5_services_reconfigured";
  if (s.status === "pending_deployment") return "4_origin_setup_completed";
  return "2_initiated";
}

function wrap(s: CustomHostnameState, extra?: Record<string, unknown>) {
  return { result: { ...toResponse(s), ...(extra ?? {}) }, status: stepStatus(s) };
}

async function save(p: Project, s: CustomHostnameState): Promise<void> {
  await db.update(projectTable).set({ customHostname: s }).where(eq(projectTable.id, p.id));
}

export async function getCustomHostname(p: Project) {
  ensureDedicated(p);
  const s = p.customHostname as CustomHostnameState | null;
  if (!s?.hostname) {
    throw new AppError(404, "no_hostname", "custom hostname configuration not found");
  }
  return wrap(s);
}

export async function initializeCustomHostname(p: Project, hostname: string) {
  ensureDedicated(p);
  const clean = hostname.trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(clean)) {
    throw new AppError(400, "invalid_hostname", "Enter a valid hostname (e.g. api.example.com)");
  }
  const { ec2 } = await ec2For(p);
  const originIp = await publicIp(p, ec2);
  const originHost = (p.connection as { host?: string } | null)?.host;
  const txtValue = createHash("sha256").update(`${p.ref}:${clean}`).digest("hex").slice(0, 40);
  const s: CustomHostnameState = {
    hostname: clean,
    status: "pending_validation",
    sslStatus: "pending_validation",
    originIp,
    originHost,
    txtValue,
    createdAt: new Date().toISOString(),
  };
  await save(p, s);
  return wrap(s);
}

export async function reverifyCustomHostname(p: Project) {
  ensureDedicated(p);
  const s = p.customHostname as CustomHostnameState | null;
  if (!s?.hostname) throw new AppError(404, "no_hostname", "custom hostname configuration not found");
  let resolved: string[] = [];
  try {
    resolved = await dns.resolve4(s.hostname);
  } catch {
    resolved = [];
  }
  const points = !!s.originIp && resolved.includes(s.originIp);
  const next: CustomHostnameState = {
    ...s,
    status: points ? "pending_deployment" : "pending_validation",
    sslStatus: points ? "pending_deployment" : "pending_validation",
  };
  await save(p, next);
  return wrap(
    next,
    points
      ? undefined
      : {
          verification_errors: [
            `${s.hostname} does not resolve to ${s.originIp ?? "the instance"} yet — add the A record and retry.`,
          ],
        }
  );
}

// Cheap pre-flight guards for activation (dedicated infra, running instance, a configured
// hostname) — run synchronously in the route so the user gets immediate feedback before the
// slow SSM work is enqueued.
export function assertActivatableCustomHostname(p: Project): void {
  ensureDedicated(p);
  // The Caddy enable runs over SSM — the instance must be running.
  if (p.status !== "active") {
    throw new AppError(409, "project_not_running", `Project is ${p.status} — resume it before activating a custom hostname`);
  }
  const s = p.customHostname as CustomHostnameState | null;
  if (!s?.hostname) throw new AppError(404, "no_hostname", "custom hostname configuration not found");
}

export async function activateCustomHostname(p: Project) {
  assertActivatableCustomHostname(p);
  const s = p.customHostname as CustomHostnameState;
  const { ec2, ssm } = await ec2For(p);
  // Open 80 + 443 (Let's Encrypt HTTP-01 + HTTPS) on the shared SG (idempotent).
  const sg = await ec2.send(
    new DescribeSecurityGroupsCommand({ Filters: [{ Name: "group-name", Values: [SG_NAME] }] })
  );
  const groupId = sg.SecurityGroups?.[0]?.GroupId;
  if (groupId) {
    for (const port of [80, 443]) {
      try {
        await ec2.send(
          new AuthorizeSecurityGroupIngressCommand({
            GroupId: groupId,
            IpPermissions: [
              {
                IpProtocol: "tcp",
                FromPort: port,
                ToPort: port,
                IpRanges: [{ CidrIp: "0.0.0.0/0" }],
              },
            ],
          })
        );
      } catch (e) {
        if ((e as { name?: string })?.name !== "InvalidPermission.Duplicate") throw e;
      }
    }
  }
  // Enable Caddy (TLS via Let's Encrypt) in front of kong: set PROXY_DOMAIN + add the
  // caddy compose to COMPOSE_FILE, then bring the stack up. Keep the logs overlay in the
  // file set — replacing it wholesale used to orphan the analytics/vector services.
  const cmd = `cd /opt/supabase/docker && \
sed -i '/^PROXY_DOMAIN=/d' .env && echo 'PROXY_DOMAIN=${s.hostname}' >> .env && \
sed -i '/^COMPOSE_FILE=/d' .env && echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.logs.yml:docker-compose.caddy.yml' >> .env && \
/usr/bin/docker compose up -d 2>&1 | tail -3`;
  await runCommand(ssm, instanceIdOf(p), cmd);
  const next: CustomHostnameState = { ...s, status: "active", sslStatus: "active" };
  await save(p, next);
  return wrap(next);
}

export async function deleteCustomHostname(p: Project) {
  ensureDedicated(p);
  const s = p.customHostname as CustomHostnameState | null;
  if (s?.hostname) {
    // Best-effort: disable Caddy on the instance (revert to kong-only).
    try {
      const { ssm } = await ec2For(p);
      await runCommand(
        ssm,
        instanceIdOf(p),
        `cd /opt/supabase/docker && sed -i '/^COMPOSE_FILE=/d' .env && echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.logs.yml' >> .env && sed -i '/^PROXY_DOMAIN=/d' .env && /usr/bin/docker compose up -d --remove-orphans 2>&1 | tail -2`
      );
    } catch {
      // instance gone / unreachable — just clear the record
    }
  }
  await db.update(projectTable).set({ customHostname: null }).where(eq(projectTable.id, p.id));
  return { result: null };
}
