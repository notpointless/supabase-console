import { Hono } from "hono";
import { count, eq } from "drizzle-orm";
import { db } from "../db/client";
import { project } from "../db/schema";
import { requireSession, requirePermission } from "../http/guards";
import { USAGE_METRICS } from "./metrics";

export const usage = new Hono();

// Member permission: project:content (same as listing projects).
const MEMBER: Record<string, string[]> = { project: ["content"] };

// ---------------------------------------------------------------------------
// GET /api/v1/organizations/:orgId/usage
//
// Returns informational usage metrics for the organisation.
// Self-hosted — no billing cycle, no overage, no invoices.
// `used` is 0 for all metrics; real collection from running stacks is deferred
// until a telemetry pipeline is in place.
// `projectCount` is derived directly from the DB (no telemetry needed).
// ---------------------------------------------------------------------------
usage.get("/api/v1/organizations/:orgId/usage", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, MEMBER);

  const [row] = await db
    .select({ count: count() })
    .from(project)
    .where(eq(project.organizationId, orgId));

  const projectCount = Number(row?.count ?? 0);

  return c.json({
    billing: null, // self-hosted: no billing cycle / overage
    projectCount,
    // TODO: collect real `used` values from running-stack telemetry.
    metrics: USAGE_METRICS.map((m) => ({ ...m, used: 0 })),
  });
});
