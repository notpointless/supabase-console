import { spawn } from "node:child_process";
import { SSMClient } from "@aws-sdk/client-ssm";
import type { Project } from "../db/schema";
import { AppError } from "../http/error";
import { getCredentials } from "../aws/credentials-service";
import { runCommand } from "./ec2-ssm";

// Run SQL on a project's own Postgres as `supabase_admin` (the real superuser /
// owner of supabase-internal schemas like _realtime; the `postgres` role is NOT a
// superuser here and can't write them).
//
// Shared-infra projects use a local `docker exec` into the db container. Dedicated
// (EC2) projects run the same psql on the remote box over the SSM remote-exec seam.

// --- shared: local docker exec ---
function psqlLocal(project: Project, sql: string): Promise<string> {
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

// --- dedicated (EC2): psql in the remote `supabase-db` container via SSM ---
async function psqlEc2(project: Project, sql: string): Promise<string> {
  const instanceId = (project.connection as { instanceId?: string } | null)?.instanceId;
  if (!instanceId) {
    throw new AppError(400, "ec2_no_instance", "Dedicated project has no running instance");
  }
  const creds = await getCredentials(project.organizationId);
  const ssm = new SSMClient({
    region: project.region,
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
  });
  // Base64-encode the SQL and pipe it to psql's stdin on the box, so we never have to
  // shell-escape arbitrary SQL through SSM.
  const b64 = Buffer.from(sql, "utf8").toString("base64");
  const cmd = `echo ${b64} | base64 -d | /usr/bin/docker exec -i supabase-db psql -U supabase_admin -d postgres -t -A -f -`;
  return runCommand(ssm, instanceId, cmd);
}

function psql(project: Project, sql: string): Promise<string> {
  return project.infrastructureType === "shared" ? psqlLocal(project, sql) : psqlEc2(project, sql);
}

/** Run a SELECT and return its rows as parsed JSON objects. */
export async function queryProjectDb<T = Record<string, unknown>>(project: Project, selectSql: string): Promise<T[]> {
  const wrapped = `select coalesce(json_agg(t), '[]'::json)::text from (${selectSql}) t`;
  const out = (await psql(project, wrapped)).trim();
  return JSON.parse(out || "[]") as T[];
}

/** Run a write statement (UPDATE/INSERT/DELETE). No return value. */
export async function execProjectDb(project: Project, sql: string): Promise<void> {
  await psql(project, sql);
}
