import type { Project } from "../db/schema";
import { queryProjectDb, execProjectDb } from "./project-db";

// These map 1:1 to columns on the realtime `_realtime.tenants` row. Realtime reads
// them per-tenant, so updates apply without restarting the container.
const NUMERIC_FIELDS = [
  "max_concurrent_users",
  "max_events_per_second",
  "max_bytes_per_second",
  "max_channels_per_client",
  "max_joins_per_second",
  "max_presence_events_per_second",
  "max_payload_size_in_kb",
] as const;
const BOOL_FIELDS = ["private_only", "suspend"] as const;

export interface RealtimeConfig {
  private_only: boolean;
  connection_pool: number;
  max_concurrent_users: number;
  max_events_per_second: number;
  max_bytes_per_second: number;
  max_channels_per_client: number;
  max_joins_per_second: number;
  max_presence_events_per_second: number;
  max_payload_size_in_kb: number;
  suspend: boolean;
}

const DEFAULTS: RealtimeConfig = {
  private_only: false,
  connection_pool: 2,
  max_concurrent_users: 200,
  max_events_per_second: 100,
  max_bytes_per_second: 100000,
  max_channels_per_client: 100,
  max_joins_per_second: 100,
  max_presence_events_per_second: 100,
  max_payload_size_in_kb: 100,
  suspend: false,
};

export async function getRealtimeConfig(project: Project): Promise<RealtimeConfig> {
  const cols = [...NUMERIC_FIELDS, ...BOOL_FIELDS].join(", ");
  const rows = await queryProjectDb<Record<string, unknown>>(
    project,
    `select ${cols} from _realtime.tenants order by inserted_at asc limit 1`
  );
  const r = rows[0];
  if (!r) return { ...DEFAULTS };
  const out: RealtimeConfig = { ...DEFAULTS };
  for (const f of NUMERIC_FIELDS) if (r[f] != null) (out as any)[f] = Number(r[f]);
  for (const f of BOOL_FIELDS) if (r[f] != null) (out as any)[f] = Boolean(r[f]);
  return out;
}

export async function updateRealtimeConfig(
  project: Project,
  patch: Partial<RealtimeConfig>
): Promise<RealtimeConfig> {
  // Values are coerced to number/boolean and inlined — no string interpolation,
  // so there is no injection surface.
  const sets: string[] = [];
  for (const f of NUMERIC_FIELDS) {
    if (patch[f] !== undefined && Number.isFinite(Number(patch[f]))) {
      sets.push(`${f} = ${Math.trunc(Number(patch[f]))}`);
    }
  }
  for (const f of BOOL_FIELDS) {
    if (patch[f] !== undefined) {
      sets.push(`${f} = ${patch[f] ? "true" : "false"}`);
    }
  }
  if (sets.length > 0) {
    await execProjectDb(project, `update _realtime.tenants set ${sets.join(", ")}, updated_at = now()`);
  }
  return getRealtimeConfig(project);
}
