import { Hono } from "hono";
import { z } from "zod";
import { requireSession, requirePermission } from "../http/guards";
import { AppError } from "../http/error";
import { availableRegions } from "../regions";
import {
  setCredentials,
  getCredentialsStatus,
  deleteCredentials,
  hasValidCredentials,
} from "../aws/credentials-service";
import {
  createProject,
  getProjectByRef,
  listProjects,
  pauseProject,
  resumeProject,
  restartProject,
  resizeProject,
  getProjectMetrics,
  getProjectDisk,
  resizeProjectDisk,
  deleteProject,
} from "./service";
import { getProjectSecrets, derivePublishableKey, deriveSecretKey, deriveSigningKeys } from "./secrets";
import type { Project } from "../db/schema";
import { project, organization, member } from "../db/schema";
import { db } from "../db/client";
import { eq, and } from "drizzle-orm";
import { getQueue } from "../jobs/queue";
import { listBackups, createBackup, backupFilePath, restoreBackup } from "./backups";
import { listPhysicalBackups, createPhysicalBackup, physicalBackupData } from "./physical-backups";
import { queryProjectAnalytics } from "./analytics";
import { listFunctionSecrets, setFunctionSecrets, deleteFunctionSecrets } from "./function-secrets";
import { getRealtimeConfig, updateRealtimeConfig } from "./realtime-config";
import {
  getCustomHostname,
  initializeCustomHostname,
  reverifyCustomHostname,
  activateCustomHostname,
  deleteCustomHostname,
} from "./custom-hostname";
import { readFileSync } from "node:fs";
import { listBranches, createBranch, getBranchById, deleteBranch, resetBranch, mapBranch, branchSchemaDiff } from "./branches";
import { listThirdPartyAuth, addThirdPartyAuth, deleteThirdPartyAuth } from "./third-party-auth";
import { listFunctions, getFunction, getFunctionFiles, deployFunction, deleteFunction } from "./functions";
import { mergeBranchToProduction } from "../integrations/github-deploy";
import { readStandbyKeys, addStandbyKey, removeStandbyKey, setStandbyKeyStatus } from "./signing-keys-store";
import { assertMfaCompliant } from "../auth/mfa";

export const projects = new Hono();

const MEMBER: Record<string, string[]> = { project: ["content"] };
const OWNER_ADMIN: Record<string, string[]> = { member: ["create"] };

projects.get("/api/v1/organizations/:orgId/regions", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, MEMBER);
  const valid = await hasValidCredentials(orgId);
  return c.json({ regions: availableRegions(valid) });
});

const credsSchema = z.object({
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  defaultRegion: z.string().min(1),
});

projects.post("/api/v1/organizations/:orgId/aws-credentials", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, OWNER_ADMIN);
  const parsed = credsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError(400, "validation_error", "Invalid credentials payload", parsed.error.flatten());
  const status = await setCredentials({ organizationId: orgId, ...parsed.data });
  if (!status.validated) throw new AppError(400, "invalid_credentials", "AWS credentials failed validation");
  return c.json(status);
});

projects.get("/api/v1/organizations/:orgId/aws-credentials", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, OWNER_ADMIN);
  return c.json(await getCredentialsStatus(orgId));
});

projects.delete("/api/v1/organizations/:orgId/aws-credentials", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, OWNER_ADMIN);
  await deleteCredentials(orgId);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Project routes
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function publicProject({ dbPasswordEncrypted: _pw, ...rest }: Project) {
  return rest;
}

const createSchema = z.object({
  name: z.string().min(1),
  region: z.string().min(1),
  dbPassword: z.string().min(8),
  postgresType: z.enum(["postgres", "orioledb"]).optional(),
  computeSize: z.string().optional(),
  dataApiEnabled: z.boolean().optional(),
  autoExposeNewTables: z.boolean().optional(),
  autoEnableRls: z.boolean().optional(),
});

projects.post("/api/v1/organizations/:orgId/projects", async (c) => {
  const session = await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, { project: ["create"] });
  await assertMfaCompliant(c, orgId);
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError(400, "validation_error", "Invalid project payload", parsed.error.flatten());
  const created = await createProject({ organizationId: orgId, createdBy: session.user.id, ...parsed.data });
  return c.json(publicProject(created));
});

projects.get("/api/v1/organizations/:orgId/projects", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, { project: ["content"] });
  const rows = await listProjects(orgId);
  return c.json({ projects: rows.map(publicProject) });
});

projects.get("/api/v1/projects/:ref", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["content"] });
  return c.json(publicProject(row));
});

projects.post("/api/v1/projects/:ref/pause", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  await pauseProject(ref);
  return c.json(publicProject((await getProjectByRef(ref))!));
});

projects.post("/api/v1/projects/:ref/resume", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  await resumeProject(ref);
  return c.json(publicProject((await getProjectByRef(ref))!));
});

// Custom hostname (dedicated/EC2 only) — matches the Supabase custom-domains UI.
projects.get("/api/v1/projects/:ref/custom-hostname", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["content"] });
  return c.json(await getCustomHostname(row));
});

projects.post("/api/v1/projects/:ref/custom-hostname/initialize", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  const body = z.object({ custom_hostname: z.string().min(1) }).parse(await c.req.json());
  return c.json(await initializeCustomHostname(row, body.custom_hostname));
});

projects.post("/api/v1/projects/:ref/custom-hostname/reverify", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  return c.json(await reverifyCustomHostname(row));
});

projects.post("/api/v1/projects/:ref/custom-hostname/activate", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  return c.json(await activateCustomHostname(row));
});

projects.delete("/api/v1/projects/:ref/custom-hostname", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  return c.json(await deleteCustomHostname(row));
});

// Change a dedicated project's compute size. The dashboard sends this as a billing
// "compute_instance" addon (ci_<size>); we map it to an instance resize. GET returns
// the available tiers + current so the compute-and-disk page can render.
projects.get("/api/v1/projects/:ref/billing/addons", async (c) => {
  await requireSession(c);
  const row = await getProjectByRef(c.req.param("ref"));
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["content"] });
  // Custom domains are dedicated/EC2 only — surface the custom_domain addon there so the
  // dashboard enables the Custom Domains page (it gates on this addon being present).
  const selected_addons =
    row.infrastructureType === "shared"
      ? []
      : [{ type: "custom_domain", variant: { identifier: "cd_default", name: "Custom Domain" } }];
  return c.json({ selected_addons, available_addons: [], compute_size: row.computeSize });
});

projects.post("/api/v1/projects/:ref/billing/addons", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  const body = (await c.req.json().catch(() => ({}))) as { addon_type?: string; addon_variant?: string };
  if (body.addon_type === "compute_instance" && body.addon_variant) {
    await resizeProject(ref, body.addon_variant.replace(/^ci_/, "")); // ci_large -> large
  }
  return c.json({ ok: true });
});

// Current resource usage. EC2 -> CloudWatch CPU (no AWS resources created).
projects.get("/api/v1/projects/:ref/metrics", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["content"] });
  return c.json(await getProjectMetrics(ref));
});

// Disk (EBS) config for a dedicated project — live from AWS; ModifyVolume is online.
projects.get("/api/v1/projects/:ref/disk", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["content"] });
  return c.json(await getProjectDisk(ref));
});

const diskSchema = z.object({
  sizeGb: z.number().int().min(8).max(16384),
  iops: z.number().int().min(3000).max(16000),
  throughput: z.number().int().min(125).max(1000),
  type: z.string().default("gp3"),
});

projects.post("/api/v1/projects/:ref/disk", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  const parsed = diskSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError(400, "validation_error", "Invalid disk payload", parsed.error.flatten());
  await resizeProjectDisk(ref, parsed.data);
  return c.json({ ok: true });
});

// Restart the whole project stack.
projects.post("/api/v1/projects/:ref/restart", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  await restartProject(ref);
  return c.json(publicProject(row));
});

// Restart specific services (body: { services: string[] } or { restartRequest: { services } }).
projects.post("/api/v1/projects/:ref/restart-services", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  const body = (await c.req.json().catch(() => ({}))) as {
    services?: string[];
    restartRequest?: { services?: string[] };
  };
  const services = body.restartRequest?.services ?? body.services ?? [];
  await restartProject(ref, services);
  return c.json(publicProject(row));
});

// Realtime configuration (reads/writes the project's _realtime.tenants row; applies live).
projects.get("/api/v1/projects/:ref/config/realtime", async (c) => {
  await requireSession(c);
  const row = await getProjectByRef(c.req.param("ref"));
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["content"] });
  try {
    return c.json(await getRealtimeConfig(row));
  } catch (e) {
    throw new AppError(502, "realtime_config_error", e instanceof Error ? e.message : "Failed to read realtime config");
  }
});

projects.patch("/api/v1/projects/:ref/config/realtime", async (c) => {
  await requireSession(c);
  const row = await getProjectByRef(c.req.param("ref"));
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return c.json(await updateRealtimeConfig(row, body));
  } catch (e) {
    throw new AppError(502, "realtime_config_error", e instanceof Error ? e.message : "Failed to update realtime config");
  }
});

// Enable/disable the REST Data API for a project (toggle public schema exposure).
projects.patch("/api/v1/projects/:ref/data-api", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  const body = await c.req.json().catch(() => ({}) as any);
  const enabled = !!body.enabled;
  await db
    .update(project)
    .set({ dataApiEnabled: enabled, autoExposeNewTables: enabled, updatedAt: new Date() })
    .where(eq(project.ref, ref));
  // Re-apply to the running stack asynchronously (a reconfigure recreates containers; inline
  // would time the dashboard out). The flag is persisted regardless.
  if (row.status === "active") await getQueue().enqueue("reconfigure", { ref });
  return c.json(publicProject((await getProjectByRef(ref))!));
});

// ---------------------------------------------------------------------------
// Project transfer (move a project to another organization).
// Shared-infra projects can be transferred freely (stack runs on our control
// plane). Dedicated (EC2) projects CANNOT — the instance lives in the source
// org's AWS account, so transferring would orphan it.
// ---------------------------------------------------------------------------
async function resolveTargetOrg(slug: string | undefined) {
  if (!slug) return undefined;
  const [org] = await db.select().from(organization).where(eq(organization.slug, slug));
  return org;
}

projects.post("/api/v1/projects/:ref/transfer/preview", async (c) => {
  const session = await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, OWNER_ADMIN);

  const body = await c.req.json().catch(() => ({}) as any);
  const target = await resolveTargetOrg(body?.target_organization_slug);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!body?.target_organization_slug) errors.push("Target organization is required.");
  else if (!target) errors.push("Target organization not found.");

  if (row.infrastructureType !== "shared") {
    errors.push(
      "Dedicated (AWS/EC2) projects can't be transferred between organizations — the instance is tied to the source organization's AWS account."
    );
  }

  if (target) {
    const [m] = await db
      .select()
      .from(member)
      .where(and(eq(member.organizationId, target.id), eq(member.userId, session.user.id)));
    if (!m) errors.push("You must be a member of the target organization.");
    else if (m.role !== "owner" && m.role !== "admin")
      warnings.push("Your permissions in the target organization may differ after transfer.");
  }

  return c.json({
    valid: errors.length === 0,
    errors,
    warnings,
    members_exceeding_free_project_limit: [],
    target_organization_eligible: !!target,
    source_subscription_plan: "free",
    target_subscription_plan: "free",
  });
});

projects.post("/api/v1/projects/:ref/transfer", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, OWNER_ADMIN);

  if (row.infrastructureType !== "shared") {
    throw new AppError(
      400,
      "transfer_not_allowed",
      "Dedicated (AWS/EC2) projects can't be transferred between organizations."
    );
  }

  const body = await c.req.json().catch(() => ({}) as any);
  if (!body?.target_organization_slug)
    throw new AppError(400, "validation_error", "target_organization_slug is required");
  const target = await resolveTargetOrg(body.target_organization_slug);
  if (!target) throw new AppError(404, "org_not_found", "Target organization not found");
  // Caller must also be an owner/admin of the destination org.
  await requirePermission(c, target.id, OWNER_ADMIN);

  await db
    .update(project)
    .set({ organizationId: target.id, updatedAt: new Date() })
    .where(eq(project.ref, ref));
  return c.json(publicProject((await getProjectByRef(ref))!));
});

projects.delete("/api/v1/projects/:ref", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["delete"] });
  await deleteProject(ref);
  return c.json({ ok: true });
});

projects.get("/api/v1/projects/:ref/api-keys", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["content"] });
  const secrets = await getProjectSecrets(row.id);
  if (!secrets) throw new AppError(404, "project_secrets_not_found", "Project secrets not found");
  return c.json({
    anonKey: secrets.anonKey,
    serviceRoleKey: secrets.serviceRoleKey,
    publishableKey: derivePublishableKey(secrets.jwtSecret),
    secretKey: deriveSecretKey(secrets.jwtSecret),
  });
});

// [console fork] Foundation for the project-internal admin (auth providers, OAuth server,
// hooks, etc.). Returns where to reach this project's OWN Kong/GoTrue + the per-project
// service_role/anon tokens, so the studio BFFs can talk to the right project instead of a
// fixed single-tenant endpoint. Authorized like every project route (org membership). The
// jwtSecret itself is never returned — only the minted JWTs.
projects.get("/api/v1/projects/:ref/internal-config", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["content"] });
  const secrets = await getProjectSecrets(row.id);
  if (!secrets) throw new AppError(404, "project_secrets_not_found", "Project secrets not found");
  // Shared projects expose Kong on the control-plane host; EC2 projects on the instance host.
  // Only a RUNNING project gets an endpoint — a paused/stopped instance is unreachable and
  // the BFFs that consume this fetch it with no timeout (each call would hang).
  let endpoint = "";
  if (row.status === "active") {
    if (row.infrastructureType === "shared") {
      if (row.kongHttpPort != null) endpoint = `http://localhost:${row.kongHttpPort}`;
    } else {
      const conn = (row.connection ?? {}) as { host?: string };
      if (conn.host) endpoint = `http://${conn.host}:8000`;
    }
  }
  return c.json({
    endpoint,
    serviceRoleKey: secrets.serviceRoleKey,
    anonKey: secrets.anonKey,
    infrastructureType: row.infrastructureType,
  });
});

// [console fork] Analytics proxy — the dashboard's report/log graphs query the project's own
// Logflare through here. The studio BFF builds the endpoint name + params (sql / interval /
// timestamps) and we forward to Logflare with the project's private token (held server-side,
// never exposed). Same authorization as every project route (org membership).
async function handleAnalyticsQuery(c: any) {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["content"] });
  const secrets = await getProjectSecrets(row.id);
  if (!secrets) throw new AppError(404, "project_secrets_not_found", "Project secrets not found");
  // Merge query params with a JSON body (the logs explorer POSTs sql + timestamps, which can be
  // large). Body wins for overlapping keys.
  const params = { ...(c.req.query() as Record<string, string | undefined>) };
  if (c.req.method === "POST") {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    for (const [k, v] of Object.entries(body ?? {})) {
      if (v !== null && v !== undefined) params[k] = String(v);
    }
  }
  const { status, body } = await queryProjectAnalytics(row, secrets.jwtSecret, c.req.param("name"), params);
  return c.json(body as any, status as any);
}
projects.get("/api/v1/projects/:ref/analytics/query/:name", handleAnalyticsQuery);
projects.post("/api/v1/projects/:ref/analytics/query/:name", handleAnalyticsQuery);

// [console fork] Per-project GoTrue auth-config (the Authentication settings pages).
// Supabase keeps this in its platform DB; we store it on the project so buildStack can apply
// it to GoTrue (signups, OAuth providers, the OAuth server, rate limits, etc.). GET returns
// the saved overrides; PATCH merges them in and reconfigures so the running stack picks up
// the change immediately. The override is persisted regardless, so it also applies on the
// next (re)provision — including for paused/EC2 projects when they next come up.
projects.get("/api/v1/projects/:ref/auth-config", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["content"] });
  return c.json((row.authConfig ?? {}) as Record<string, unknown>);
});

projects.patch("/api/v1/projects/:ref/auth-config", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const merged = { ...((row.authConfig ?? {}) as Record<string, unknown>), ...(body ?? {}) };
  await db
    .update(project)
    .set({ authConfig: merged, updatedAt: new Date() })
    .where(eq(project.id, row.id));
  // Apply to the live stack ASYNCHRONOUSLY: a reconfigure recreates containers (the GoTrue
  // restart alone is 10-30s), so doing it inline timed the dashboard out. The override is
  // persisted regardless and also applies on the next (re)provision (paused/EC2 included).
  if (row.status === "active") await getQueue().enqueue("reconfigure", { ref });
  return c.json(merged);
});

// [console fork] Third-Party Auth integrations (external JWT issuers). List/add/remove,
// stored on the project; the resolved issuer JWKS is merged into the stack verify keys on
// reconfigure so the data API accepts those tokens. EC2-compatible (same reconfigure path).
projects.get("/api/v1/projects/:ref/third-party-auth", async (c) => {
  await requireSession(c);
  const row = await getProjectByRef(c.req.param("ref"));
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["content"] });
  return c.json(listThirdPartyAuth(row));
});

projects.post("/api/v1/projects/:ref/third-party-auth", async (c) => {
  await requireSession(c);
  const row = await getProjectByRef(c.req.param("ref"));
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const created = await addThirdPartyAuth(row, body);
  // Merge the new issuer's keys into the stack verify set asynchronously (reconfigure recreates
  // containers; doing it inline would time the dashboard out).
  if (row.status === "active") await getQueue().enqueue("reconfigure", { ref: row.ref });
  return c.json(created);
});

projects.delete("/api/v1/projects/:ref/third-party-auth/:id", async (c) => {
  await requireSession(c);
  const row = await getProjectByRef(c.req.param("ref"));
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  await deleteThirdPartyAuth(row, c.req.param("id"));
  if (row.status === "active") await getQueue().enqueue("reconfigure", { ref: row.ref });
  return c.json({ deleted: true });
});

// [console fork] Storage settings overrides (the Storage settings page). Stored on the project
// so buildStack can apply the upload size limit (FILE_SIZE_LIMIT) to the storage container.
// PATCH merges + reconfigures async (same pattern as auth-config).
projects.get("/api/v1/projects/:ref/storage-config", async (c) => {
  await requireSession(c);
  const row = await getProjectByRef(c.req.param("ref"));
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["content"] });
  return c.json((row.storageConfig ?? {}) as Record<string, unknown>);
});

projects.patch("/api/v1/projects/:ref/storage-config", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const merged = { ...((row.storageConfig ?? {}) as Record<string, unknown>), ...(body ?? {}) };
  await db.update(project).set({ storageConfig: merged, updatedAt: new Date() }).where(eq(project.id, row.id));
  if (row.status === "active") await getQueue().enqueue("reconfigure", { ref });
  return c.json(merged);
});

// [console fork] Edge functions — read/deploy/delete the project's functions volume (the
// edge-runtime serves it). Infra-aware (local fs for shared, SSM for EC2). The /files endpoint
// returns JSON; the studio BFF adapts it to the multipart shape the function editor expects.
projects.get("/api/v1/projects/:ref/functions", async (c) => {
  await requireSession(c);
  const row = await getProjectByRef(c.req.param("ref"));
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["content"] });
  return c.json(await listFunctions(row));
});

// Deploy (create/overwrite). Slug in the query (?slug=). The dashboard sends multipart/form-data:
// one or more `file` parts (each a File, its filename = the path) + a `metadata` JSON part.
projects.post("/api/v1/projects/:ref/functions/deploy", async (c) => {
  await requireSession(c);
  const row = await getProjectByRef(c.req.param("ref"));
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  const slug = c.req.query("slug") ?? "";

  const form = await c.req.parseBody({ all: true });
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(typeof form.metadata === "string" ? form.metadata : "{}");
  } catch {
    /* no metadata */
  }
  const rawFiles = Array.isArray(form.file) ? form.file : form.file ? [form.file] : [];
  const files: Array<{ name: string; content: string }> = [];
  for (const f of rawFiles) {
    if (f instanceof File) files.push({ name: f.name, content: await f.text() });
  }

  const created = await deployFunction(row, slug, files, metadata as any);
  return c.json(created);
});

projects.get("/api/v1/projects/:ref/functions/:slug", async (c) => {
  await requireSession(c);
  const row = await getProjectByRef(c.req.param("ref"));
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["content"] });
  const fn = await getFunction(row, c.req.param("slug"));
  if (!fn) throw new AppError(404, "function_not_found", "Function not found");
  return c.json(fn);
});

// Source files as JSON (the BFF turns this into multipart for the editor).
projects.get("/api/v1/projects/:ref/functions/:slug/files", async (c) => {
  await requireSession(c);
  const row = await getProjectByRef(c.req.param("ref"));
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["content"] });
  const fn = await getFunction(row, c.req.param("slug"));
  if (!fn) throw new AppError(404, "function_not_found", "Function not found");
  return c.json({ files: await getFunctionFiles(row, c.req.param("slug")), metadata: fn });
});

// Patch metadata (name / verify_jwt) — re-write keeping the existing files.
projects.patch("/api/v1/projects/:ref/functions/:slug", async (c) => {
  await requireSession(c);
  const row = await getProjectByRef(c.req.param("ref"));
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  const slug = c.req.param("slug");
  const files = await getFunctionFiles(row, slug);
  if (files.length === 0) throw new AppError(404, "function_not_found", "Function not found");
  const patch = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  return c.json(await deployFunction(row, slug, files, patch as any));
});

projects.delete("/api/v1/projects/:ref/functions/:slug", async (c) => {
  await requireSession(c);
  const row = await getProjectByRef(c.req.param("ref"));
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  await deleteFunction(row, c.req.param("slug"));
  return c.json({ ok: true });
});

// Database backups: logical (pg_dump, all projects) + physical (EBS snapshots, EC2 only).
projects.get("/api/v1/projects/:ref/backups", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["content"] });
  const physical = await listPhysicalBackups(row);
  return c.json({
    backups: [...physical, ...listBackups(ref)].sort((a, b) => b.id - a.id),
    region: row.region ?? "shared",
    walg_enabled: false,
    pitr_enabled: false,
    // Physical backups are an EC2 capability; "enabled" once the first snapshot exists.
    physicalBackupsEnabled: physical.length > 0,
    physicalBackupsAvailable: row.infrastructureType !== "shared",
    physicalBackupData: physicalBackupData(physical),
  });
});

// Enable physical backups (EC2): take the first EBS snapshot now. The daily backup job keeps
// snapshotting projects that have at least one (with retention pruning). Clear 400 for shared.
projects.post("/api/v1/projects/:ref/backups/enable-physical", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  const backup = await createPhysicalBackup(row);
  return c.json(backup);
});

// Restore a physical backup (EC2): swap the root volume for one built from the snapshot.
// Runs as a background job (the volume swap takes minutes); the project shows RESTORING.
projects.post("/api/v1/projects/:ref/backups/:id/restore-physical", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  if (row.infrastructureType === "shared") {
    throw new AppError(400, "physical_backups_unavailable", "Physical backups are only available for dedicated (AWS EC2) projects.");
  }
  if (row.status !== "active" && row.status !== "paused") {
    throw new AppError(409, "project_busy", `Project is ${row.status}; wait for it to settle before restoring`);
  }
  await db
    .update(project)
    .set({ status: "resuming", updatedAt: new Date() })
    .where(eq(project.id, row.id));
  await getQueue().enqueue("restore_physical", { ref, id: Number(c.req.param("id")) });
  return c.json({ ok: true, status: "restoring" });
});

projects.post("/api/v1/projects/:ref/backups", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  // pg_dump needs the project's Postgres running (shared: container; EC2: instance over TCP).
  if (row.status !== "active") {
    throw new AppError(409, "project_not_running", `Project is ${row.status} — resume it before creating a backup`);
  }
  try {
    const backup = await createBackup(row);
    // Dedicated projects also get an EBS snapshot (their physical backup) — the logical dump
    // covers data-level restore, the snapshot covers full-volume restore. Best-effort.
    if (row.infrastructureType !== "shared") {
      await createPhysicalBackup(row).catch(() => {});
    }
    return c.json(backup);
  } catch (e) {
    throw new AppError(500, "backup_failed", e instanceof Error ? e.message : "Backup failed");
  }
});

// Stream a logical backup's .dump file for download.
projects.get("/api/v1/projects/:ref/backups/:id/download", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["content"] });
  const file = backupFilePath(ref, Number(c.req.param("id")));
  if (!file) throw new AppError(404, "backup_not_found", "Backup not found");
  const buf = readFileSync(file);
  return c.body(buf as any, 200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${ref}-${c.req.param("id")}.dump"`,
  });
});

// Restore a logical backup into the project's database (pg_restore --clean).
projects.post("/api/v1/projects/:ref/backups/:id/restore", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  // pg_restore needs the project's Postgres running.
  if (row.status !== "active") {
    throw new AppError(409, "project_not_running", `Project is ${row.status} — resume it before restoring a backup`);
  }
  try {
    await restoreBackup(row, Number(c.req.param("id")));
    return c.json({ ok: true });
  } catch (e) {
    throw new AppError(500, "restore_failed", e instanceof Error ? e.message : "Restore failed");
  }
});

// --- Edge Function secrets (Management API style) ---------------------------
projects.get("/api/v1/projects/:ref/secrets", async (c) => {
  await requireSession(c);
  const row = await getProjectByRef(c.req.param("ref"));
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["content"] });
  return c.json(await listFunctionSecrets(row.id));
});

const secretItem = z.object({ name: z.string().min(1), value: z.string() });
projects.post("/api/v1/projects/:ref/secrets", async (c) => {
  await requireSession(c);
  const row = await getProjectByRef(c.req.param("ref"));
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  const parsed = z.array(secretItem).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError(400, "validation_error", "Expected an array of {name,value}", parsed.error.flatten());
  for (const s of parsed.data) {
    if (/^SUPABASE_/.test(s.name)) {
      throw new AppError(400, "validation_error", `Secret name must not start with SUPABASE_: ${s.name}`);
    }
  }
  await setFunctionSecrets(row, parsed.data);
  return c.json(await listFunctionSecrets(row.id), 201);
});

projects.delete("/api/v1/projects/:ref/secrets", async (c) => {
  await requireSession(c);
  const row = await getProjectByRef(c.req.param("ref"));
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  const body = await c.req.json().catch(() => null);
  const names = Array.isArray(body) ? body.map(String) : [];
  if (!names.length) throw new AppError(400, "validation_error", "Expected an array of secret names");
  await deleteFunctionSecrets(row, names);
  return c.json(await listFunctionSecrets(row.id));
});

// ---------------------------------------------------------------------------
// Preview branches. A branch is a child project (own stack) seeded from the parent.
// ---------------------------------------------------------------------------
const createBranchSchema = z.object({
  branch_name: z.string().min(1).max(63),
  git_branch: z.string().optional().nullable(),
  with_data: z.boolean().optional(),
  // accepted for API compatibility, ignored on shared infra:
  region: z.string().optional(),
  desired_instance_size: z.string().optional(),
  is_default: z.boolean().optional(),
});

projects.get("/api/v1/projects/:ref/branches", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["content"] });
  return c.json(await listBranches(ref));
});

projects.post("/api/v1/projects/:ref/branches", async (c) => {
  const session = await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  // Branch seeding pg_dumps the parent — it must be running, or the provision task would
  // fail mid-seed with a raw pg_dump error.
  if (row.status !== "active") {
    throw new AppError(409, "project_not_running", `Project is ${row.status} — resume it before creating a branch`);
  }
  const parsed = createBranchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError(400, "validation_error", "Invalid branch payload", parsed.error.flatten());
  const branch = await createBranch({
    parentRef: ref,
    branchName: parsed.data.branch_name,
    gitBranch: parsed.data.git_branch ?? null,
    withData: parsed.data.with_data,
    createdBy: session.user.id,
  });
  return c.json(mapBranch(branch, ref));
});

// Branch-scoped operations are keyed by the branch's project id.
async function loadBranchForRequest(c: any) {
  // The dashboard's path param is {branch_id_or_ref}: it may be our branch uuid
  // OR the branch project's ref. Resolve either so delete/reset/merge always work.
  const idOrRef = c.req.param("id");
  let branch = null;
  if (/^[0-9a-fA-F-]{36}$/.test(idOrRef)) {
    branch = await getBranchById(idOrRef);
  }
  if (!branch) {
    branch = await getProjectByRef(idOrRef);
  }
  if (!branch) throw new AppError(404, "branch_not_found", "Branch not found");
  return branch;
}

projects.get("/api/v1/branches/:id", async (c) => {
  await requireSession(c);
  const branch = await loadBranchForRequest(c);
  await requirePermission(c, branch.organizationId, { project: ["content"] });
  const parentRef = branch.parentProjectId ? (await getBranchById(branch.parentProjectId))?.ref ?? branch.ref : branch.ref;
  return c.json(mapBranch(branch, parentRef, !branch.parentProjectId));
});

projects.patch("/api/v1/branches/:id", async (c) => {
  await requireSession(c);
  const branch = await loadBranchForRequest(c);
  await requirePermission(c, branch.organizationId, { project: ["update"] });
  const body = (await c.req.json().catch(() => ({}))) as { branch_name?: string; git_branch?: string | null };
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof body.branch_name === "string") patch.name = body.branch_name;
  if (body.git_branch !== undefined) patch.gitBranch = body.git_branch;
  await db.update(project).set(patch).where(eq(project.id, branch.id));
  const updated = (await getBranchById(branch.id))!;
  const parentRef = updated.parentProjectId ? (await getBranchById(updated.parentProjectId))?.ref ?? updated.ref : updated.ref;
  return c.json(mapBranch(updated, parentRef, !updated.parentProjectId));
});

projects.delete("/api/v1/branches/:id", async (c) => {
  await requireSession(c);
  const branch = await loadBranchForRequest(c);
  await requirePermission(c, branch.organizationId, { project: ["update"] });
  await deleteBranch(branch.id);
  return c.json({ message: "ok" });
});

projects.post("/api/v1/branches/:id/reset", async (c) => {
  await requireSession(c);
  const branch = await loadBranchForRequest(c);
  await requirePermission(c, branch.organizationId, { project: ["update"] });
  const body = (await c.req.json().catch(() => ({}))) as { with_data?: boolean };
  await resetBranch(branch.id, !!body.with_data);
  return c.json(mapBranch(branch, branch.ref));
});

// Merge: apply the branch's tracked Git-branch migrations to production.
projects.post("/api/v1/branches/:id/merge", async (c) => {
  await requireSession(c);
  const branch = await loadBranchForRequest(c);
  await requirePermission(c, branch.organizationId, { project: ["update"] });
  const result = await mergeBranchToProduction(branch.id);
  return c.json(result);
});

// Push a preview branch's schema changes back to its tracked Git branch as a new
// supabase/migrations file (inverse of the deploy flow). Needs the branch linked to a
// repo + an org GitHub token with contents:write.
projects.post("/api/v1/branches/:id/push", async (c) => {
  await requireSession(c);
  const branch = await loadBranchForRequest(c);
  await requirePermission(c, branch.organizationId, { project: ["update"] });
  const { pushBranchToGit } = await import("../integrations/github-deploy");
  const result = await pushBranchToGit(branch.id);
  return c.json(result);
});
projects.get("/api/v1/branches/:id/diff", async (c) => {
  await requireSession(c);
  const branch = await loadBranchForRequest(c);
  await requirePermission(c, branch.organizationId, { project: ["content"] });
  const diff = await branchSchemaDiff(branch.id);
  return c.body(diff, 200, { "Content-Type": "text/plain" });
});

// JWT signing keys for a project: the current asymmetric ES256 key (in use) and the
// legacy HS256 shared secret (still verifies older tokens). Derived from the project's
// JWT secret, so stable + reproducible.
projects.get("/api/v1/projects/:ref/signing-keys", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["content"] });
  const secrets = await getProjectSecrets(row.id);
  if (!secrets) throw new AppError(404, "project_secrets_not_found", "Project secrets not found");
  let signing;
  try {
    signing = await deriveSigningKeys(secrets.jwtSecret);
  } catch (e) {
    throw new AppError(500, "signing_key_error", `deriveSigningKeys failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const jwks = JSON.parse(signing.jwtJwks) as { keys: Array<Record<string, any>> };
  const ec = jwks.keys.find((k) => k.kty === "EC");
  const legacy = jwks.keys.find((k) => k.kty === "oct");
  const createdAt = new Date(row.createdAt ?? Date.now()).toISOString();
  return c.json({
    current: ec ? { kid: ec.kid, algorithm: "ES256", public_jwk: ec, created_at: createdAt } : null,
    legacy: legacy ? { kid: legacy.kid, algorithm: "HS256", created_at: createdAt } : null,
    standby: readStandbyKeys(ref).map((k) => ({
      kid: k.kid,
      algorithm: k.algorithm,
      status: k.status,
      public_jwk: k.publicJwk,
      created_at: k.created_at,
    })),
  });
});

// Create a new standby ES256 signing key (rotation prep): generate it, persist it, and
// re-apply the stack so every service can verify tokens signed with it.
projects.post("/api/v1/projects/:ref/signing-keys", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  const key = addStandbyKey(ref);
  if (row.status === "active") await getQueue().enqueue("reconfigure", { ref });
  return c.json({ kid: key.kid, algorithm: key.algorithm, status: key.status, created_at: key.created_at });
});

// Change a standby key's status (e.g. move to previously_used, or promote to in_use).
projects.patch("/api/v1/projects/:ref/signing-keys/:kid", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  const body = await c.req.json().catch(() => ({}) as any);
  const status = body?.status as "in_use" | "standby" | "previously_used" | "revoked";
  const ok = setStandbyKeyStatus(ref, c.req.param("kid"), status);
  if (!ok) {
    // The derived current ES256 key + legacy HS256 verifier aren't operator-managed.
    throw new AppError(400, "key_not_managed", "This key's status is managed automatically");
  }
  if (row.status === "active") await getQueue().enqueue("reconfigure", { ref });
  return c.json({ kid: c.req.param("kid"), status });
});

// Revoke a standby signing key.
projects.delete("/api/v1/projects/:ref/signing-keys/:kid", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  removeStandbyKey(ref, c.req.param("kid"));
  if (row.status === "active") await getQueue().enqueue("reconfigure", { ref });
  return c.json({ ok: true });
});

// Create the default new-format API keys. The keys are derived from the JWT secret,
// so this just ensures the running stack exposes them (kong keyauth) by re-applying
// its config, then returns them. Idempotent.
projects.post("/api/v1/projects/:ref/api-keys", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["update"] });
  const secrets = await getProjectSecrets(row.id);
  if (!secrets) throw new AppError(404, "project_secrets_not_found", "Project secrets not found");
  // Re-apply (async) so an already-running project's kong picks up the keys.
  if (row.status === "active") await getQueue().enqueue("reconfigure", { ref });
  return c.json({
    anonKey: secrets.anonKey,
    serviceRoleKey: secrets.serviceRoleKey,
    publishableKey: derivePublishableKey(secrets.jwtSecret),
    secretKey: deriveSecretKey(secrets.jwtSecret),
  });
});
