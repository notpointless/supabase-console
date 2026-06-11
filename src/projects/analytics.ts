import { createHmac } from "node:crypto";
import type { Project } from "../db/schema";
import { AppError } from "../http/error";

// [console fork] Analytics proxy. Each project's stack runs its OWN single-tenant Logflare
// (the `analytics` service, Postgres-backed) and a `vector` shipper that tags every log line
// with project "default". The dashboard's report/log graphs query Logflare through Kong at
// `/analytics/v1/api/endpoints/query/<name>`, authenticating with the project's private
// Logflare token. That token is derived from the project JWT secret (so it's stable across
// re-provision and never stored) and lives only in the control plane — the studio BFF proxies
// through here so the secret never reaches the browser tier. Works for shared (Kong on the
// control-plane host) and EC2 (Kong on the instance host).

// Single-tenant Logflare tags all ingested logs with this project id; every query must filter
// on it (the seeded endpoints + our generated SQL use @project).
export const LOGFLARE_PROJECT = "default";

// Mirror compose.ts: LOGFLARE_PRIVATE_ACCESS_TOKEN = hmac(jwtSecret, "logflare_private_v1").
function logflarePrivateToken(jwtSecret: string): string {
  return createHmac("sha256", jwtSecret).update("logflare_private_v1").digest("hex");
}

// The project's Kong base URL (same resolution as /internal-config).
function projectKongBase(row: Project): string {
  if (row.infrastructureType === "shared") {
    if (row.kongHttpPort != null) return `http://localhost:${row.kongHttpPort}`;
    return "";
  }
  const conn = (row.connection ?? {}) as { host?: string };
  return conn.host ? `http://${conn.host}:8000` : "";
}

// A Logflare endpoint name becomes a URL path segment — keep it to a safe charset.
function assertEndpointName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,64}$/.test(name)) {
    throw new AppError(400, "invalid_analytics_endpoint", `Invalid analytics endpoint: ${name}`);
  }
}

export interface AnalyticsQueryResult {
  status: number;
  body: unknown;
}

/**
 * Query a project's Logflare endpoint. `params` carries the query string the dashboard sends
 * (sql, interval, iso_timestamp_start/end, granularity, …); we force project=default and add
 * the private token. Returns Logflare's JSON + status verbatim so the BFF can pass it through.
 */
export async function queryProjectAnalytics(
  row: Project,
  jwtSecret: string,
  name: string,
  params: Record<string, string | undefined>
): Promise<AnalyticsQueryResult> {
  assertEndpointName(name);
  const base = projectKongBase(row);
  if (!base) {
    // Project isn't running (paused / not yet provisioned) — no log backend to query.
    return { status: 200, body: { result: [], error: null } };
  }

  const url = new URL(`${base}/analytics/v1/api/endpoints/query/${name}`);
  url.searchParams.set("project", LOGFLARE_PROJECT);
  for (const [k, v] of Object.entries(params)) {
    if (k === "project") continue; // never let the caller override the tenant
    if (typeof v === "string" && v.length > 0) url.searchParams.set(k, v);
  }

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "x-api-key": logflarePrivateToken(jwtSecret),
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : { result: [] };
    } catch {
      body = { result: [], error: text || "analytics backend returned non-JSON" };
    }
    return { status: res.status, body };
  } catch (err) {
    // Logflare unreachable (project restarting, etc.): degrade to an empty series rather than
    // erroring the whole graph.
    return { status: 200, body: { result: [], error: (err as Error)?.message ?? "analytics unreachable" } };
  }
}
