import { Hono } from "hono";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { auditLog } from "../db/schema";
import { requireSession, requirePermission } from "../http/guards";
import { AppError } from "../http/error";
import { listDrains, createDrain, updateDrain, deleteDrain, testDrain } from "./drains";

export const auditRoutes = new Hono();

const OWNER_ADMIN: Record<string, string[]> = { member: ["create"] };

// ---------------------------------------------------------------------------
// GET /api/v1/account/audit-logs
// Returns the current user's own actions (mutations they performed), newest first.
// ---------------------------------------------------------------------------
auditRoutes.get("/api/v1/account/audit-logs", async (c) => {
  const session = await requireSession(c);

  const logs = await db
    .select({
      id: auditLog.id,
      method: auditLog.method,
      path: auditLog.path,
      statusCode: auditLog.statusCode,
      organizationId: auditLog.organizationId,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(eq(auditLog.actorUserId, session.user.id))
    .orderBy(desc(auditLog.createdAt))
    .limit(100);

  return c.json({ logs });
});

// ---------------------------------------------------------------------------
// GET /api/v1/organizations/:orgId/audit-logs
// Returns all actions taken within an organization, newest first.
// Requires owner or admin permission (member:create).
// ---------------------------------------------------------------------------
auditRoutes.get("/api/v1/organizations/:orgId/audit-logs", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, OWNER_ADMIN);

  const logs = await db
    .select({
      id: auditLog.id,
      method: auditLog.method,
      path: auditLog.path,
      statusCode: auditLog.statusCode,
      organizationId: auditLog.organizationId,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(eq(auditLog.organizationId, orgId))
    .orderBy(desc(auditLog.createdAt))
    .limit(100);

  return c.json({ logs });
});

// ---------------------------------------------------------------------------
// Audit-log drains — stream the org's audit events to an external sink (webhook).
// ---------------------------------------------------------------------------
const createDrainSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.string().optional(),
  config: z.record(z.string(), z.unknown()),
});

auditRoutes.get("/api/v1/organizations/:orgId/audit-log-drains", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, OWNER_ADMIN);
  return c.json(await listDrains(orgId));
});

auditRoutes.post("/api/v1/organizations/:orgId/audit-log-drains", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, OWNER_ADMIN);
  const parsed = createDrainSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError(400, "validation_error", "Invalid drain payload", parsed.error.flatten());
  return c.json(await createDrain(orgId, parsed.data as { name: string; description?: string; type?: string; config: Record<string, unknown> }), 201);
});

auditRoutes.put("/api/v1/organizations/:orgId/audit-log-drains/:token", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, OWNER_ADMIN);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await updateDrain(c.req.param("token"), {
    name: typeof body.name === "string" ? body.name : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    config: body.config as Record<string, unknown> | undefined,
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
  });
  if (!result) throw new AppError(404, "not_found", "Drain not found");
  return c.json(result);
});

auditRoutes.delete("/api/v1/organizations/:orgId/audit-log-drains/:token", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, OWNER_ADMIN);
  await deleteDrain(c.req.param("token"));
  return c.json({ ok: true });
});

auditRoutes.post("/api/v1/organizations/:orgId/audit-log-drains/:token/test", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, OWNER_ADMIN);
  const result = await testDrain(c.req.param("token"));
  if (!result.ok) {
    throw new AppError(400, "drain_test_failed", result.error ?? `Drain responded with ${result.status}`);
  }
  return c.json({ ok: true, status: result.status });
});
