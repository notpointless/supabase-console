import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { auditLog } from "../db/schema";
import { requireSession, requirePermission } from "../http/guards";

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
