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
import type { Project } from "../db/schema";

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

projects.delete("/api/v1/projects/:ref", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, row.organizationId, { project: ["delete"] });
  await deleteProject(ref);
  return c.json({ ok: true });
});
