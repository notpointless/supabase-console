import { Client } from "pg";
import type { Project } from "../db/schema";
import { decrypt } from "../crypto/secrets";

export interface ProjectUsage {
  dbSizeBytes: number;
  storageBytes: number;
  mau: number;
}

const ZERO: ProjectUsage = { dbSizeBytes: 0, storageBytes: 0, mau: 0 };

// [console fork] Collect real usage straight from a project's own Postgres: database size,
// storage object bytes, and 30-day active users. Egress / cached-egress / realtime /
// edge-invocation counters require a metrics pipeline the self-host stack doesn't emit, so
// those remain 0. Best-effort per project — a paused or unreachable DB (e.g. an EC2 box with
// 5432 firewalled off) yields zeros rather than failing the whole usage request.
export async function collectProjectUsage(project: Project): Promise<ProjectUsage> {
  const conn = (project.connection ?? {}) as { host?: string; dbPort?: number };
  // Shared projects expose Postgres on the control-plane host at the project's db port;
  // dedicated (EC2) projects run it on the instance at the standard 5432.
  const host = project.infrastructureType === "shared" ? "localhost" : conn.host;
  const port =
    project.infrastructureType === "shared" ? (project.dbPort ?? conn.dbPort) : 5432;
  if (!host || !port) return ZERO;

  const client = new Client({
    host,
    port: Number(port),
    user: "postgres",
    password: decrypt(project.dbPasswordEncrypted),
    database: "postgres",
    connectionTimeoutMillis: 3000,
    statement_timeout: 4000, // never let a slow project DB wedge the usage request
  });

  try {
    await client.connect();
    const dbSize = await client.query<{ s: string }>(
      "SELECT pg_database_size(current_database()) AS s"
    );
    // storage.objects / auth.users may not exist on a bare DB — degrade to 0 each.
    const storage = await client
      .query<{ s: string }>(
        "SELECT COALESCE(SUM((metadata->>'size')::bigint), 0) AS s FROM storage.objects"
      )
      .catch(() => ({ rows: [{ s: "0" }] }));
    const mau = await client
      .query<{ c: string }>(
        "SELECT COUNT(*) AS c FROM auth.users WHERE last_sign_in_at > now() - interval '30 days'"
      )
      .catch(() => ({ rows: [{ c: "0" }] }));
    return {
      dbSizeBytes: Number(dbSize.rows[0]?.s ?? 0),
      storageBytes: Number(storage.rows[0]?.s ?? 0),
      mau: Number(mau.rows[0]?.c ?? 0),
    };
  } catch {
    return ZERO;
  } finally {
    await client.end().catch(() => {});
  }
}
