import { spawn } from "node:child_process";
import type { Project } from "../db/schema";
import { AppError } from "../http/error";

// Run SQL on a project's own Postgres as `supabase_admin` (the real superuser /
// owner of supabase-internal schemas like _realtime; the `postgres` role is NOT a
// superuser here and can't write them).
//
// Shared-infra projects use a local `docker exec` into the db container. EC2
// (remote) projects need a remote-exec seam on the provisioner (SSM/SSH) — the same
// gap as Edge Function secrets — so writes there are surfaced as "not yet supported".
function ensureLocal(project: Project): void {
  if (project.infrastructureType !== "shared") {
    throw new AppError(
      400,
      "ec2_db_unsupported",
      "Editing this setting isn't available on dedicated (EC2) projects yet."
    );
  }
}

function psql(project: Project, sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [
      "exec",
      "-i",
      `sb-${project.ref}-db-1`,
      "psql",
      "-U",
      "supabase_admin",
      "-d",
      "postgres",
      "-t",
      "-A",
      "-c",
      sql,
    ]);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.slice(0, 300) || `psql exited ${code}`))));
  });
}

/** Run a SELECT and return its rows as parsed JSON objects. */
export async function queryProjectDb<T = Record<string, unknown>>(project: Project, selectSql: string): Promise<T[]> {
  ensureLocal(project);
  const wrapped = `select coalesce(json_agg(t), '[]'::json)::text from (${selectSql}) t`;
  const out = (await psql(project, wrapped)).trim();
  return JSON.parse(out || "[]") as T[];
}

/** Run a write statement (UPDATE/INSERT/DELETE). No return value. */
export async function execProjectDb(project: Project, sql: string): Promise<void> {
  ensureLocal(project);
  await psql(project, sql);
}
