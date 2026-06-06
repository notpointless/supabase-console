import { sql, eq } from "drizzle-orm";
import { db } from "../db/client";
import { project } from "../db/schema";
import { getEnv } from "../config/env";

export interface Ports {
  kongHttpPort: number;
  kongHttpsPort: number;
  dbPort: number;
}

const PORTS_LOCK = 8123;

// Ports are monotonically allocated from max(dbPort)+1; they are NOT reclaimed on delete (acceptable at current scale; revisit if many create/delete cycles occur).
export async function allocatePorts(projectId: string): Promise<Ports> {
  const base = getEnv().PORT_BASE;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${PORTS_LOCK})`);
    const rows = await tx
      .select({ max: sql<number | null>`max(${project.dbPort})` })
      .from(project);
    const rawMax = rows[0]?.max ?? null;
    const maxDb = rawMax != null ? Number(rawMax) : null;
    const start = maxDb != null ? maxDb + 1 : base;
    const ports: Ports = {
      kongHttpPort: start,
      kongHttpsPort: start + 1,
      dbPort: start + 2,
    };
    await tx.update(project).set(ports).where(eq(project.id, projectId));
    return ports;
  });
}
