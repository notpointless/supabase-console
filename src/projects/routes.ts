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
