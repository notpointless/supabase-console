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
  deleteProject,
} from "./service";
import { getProjectSecrets } from "./secrets";
import type { Project } from "../db/schema";
import { project, organization, member } from "../db/schema";
import { db } from "../db/client";
import { eq, and } from "drizzle-orm";
import { getProvisionerFor } from "./provisioner";
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
  const updated = (await getProjectByRef(ref))!;
  // Re-apply to the running stack so PostgREST schema exposure changes immediately.
  try {
    await getProvisionerFor(updated).reconfigure?.(updated);
  } catch {
    /* best-effort; flag is persisted regardless */
  }
  return c.json(publicProject(updated));
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
  return c.json({ anonKey: secrets.anonKey, serviceRoleKey: secrets.serviceRoleKey });
});
