import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { project } from "../db/schema";
import { requireSession, requirePermission } from "../http/guards";
import { USAGE_METRICS } from "./metrics";
import { collectProjectUsage } from "./collect";

export const usage = new Hono();

// Member permission: project:content (same as listing projects).
const MEMBER: Record<string, string[]> = { project: ["content"] };

// ---------------------------------------------------------------------------
// GET /api/v1/organizations/:orgId/usage
//
// Returns informational usage metrics for the organisation. Self-hosted — no
// billing cycle, no overage, no invoices.
//
// `db_size`, `storage_size` and `monthly_active_users` are collected live from each
// active project's own Postgres (best-effort, in parallel). The remaining metrics
// (egress, cached egress, third-party/SSO MAU, image transformations, realtime, edge
// invocations) require a metrics pipeline the self-host stack doesn't emit, so they stay 0.
// ---------------------------------------------------------------------------
const GB = 1e9;

usage.get("/api/v1/organizations/:orgId/usage", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, MEMBER);

  const projects = await db.select().from(project).where(eq(project.organizationId, orgId));
  const active = projects.filter((p) => p.status === "active");

  // Collect concurrently; collectProjectUsage never throws (returns zeros on failure).
  const usages = await Promise.all(active.map((p) => collectProjectUsage(p)));
  const totals = usages.reduce(
    (acc, u) => {
      acc.dbSizeBytes += u.dbSizeBytes;
      acc.storageBytes += u.storageBytes;
      acc.mau += u.mau;
      return acc;
    },
    { dbSizeBytes: 0, storageBytes: 0, mau: 0 }
  );

  const used: Record<string, number> = {
    db_size: totals.dbSizeBytes / GB,
    storage_size: totals.storageBytes / GB,
    monthly_active_users: totals.mau,
  };

  return c.json({
    billing: null, // self-hosted: no billing cycle / overage
    projectCount: projects.length,
    metrics: USAGE_METRICS.map((m) => ({ ...m, used: used[m.id] ?? 0 })),
  });
});
