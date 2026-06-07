import { createMiddleware } from "hono/factory";
import { db } from "../db/client";
import { auditLog } from "../db/schema";
import { auth } from "../auth";

const MUTATIONS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Only capture organizationId for routes that are genuinely scoped to an org.
// This avoids FK violations on paths like /api/v1/projects/:ref that do NOT
// carry an org-id segment (organizationId would be null anyway for those).
const ORG_PATH_RE = /^\/api\/v1\/organizations\/([^/]+)/;

export const auditMiddleware = createMiddleware(async (c, next) => {
  await next();
  try {
    const method = c.req.method;
    if (!MUTATIONS.has(method)) return;
    const path = c.req.path;
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const m = ORG_PATH_RE.exec(path);
    const organizationId = m?.[1] ?? null;
    await db.insert(auditLog).values({
      actorUserId: session?.user.id ?? null,
      organizationId,
      method,
      path,
      statusCode: c.res.status,
    });
  } catch {
    // best-effort: never fail the request because of audit logging
  }
});
