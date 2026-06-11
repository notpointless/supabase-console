import { spawn } from "node:child_process";
import { SSMClient } from "@aws-sdk/client-ssm";
import type { Project } from "../db/schema";
import { getCredentials } from "../aws/credentials-service";
import { runCommand } from "./ec2-ssm";

// [console fork] Infra-aware "run SQL in a project's database" primitive. Shared-infra
// projects run their Postgres in a local Docker container (`sb-<ref>-db-1`, superuser
// `postgres`); dedicated EC2 projects run it on the instance (`supabase-db`, superuser
// `supabase_admin`) reached over SSM — no inbound DB port required. This lets the GitHub
// deploy/merge pipeline (and anything else that needs to run SQL) work identically on both,
// instead of being shared-only because it shelled out to a local container.

interface ExecTarget {
  container: string;
  user: string;
}

function targetFor(project: Project): ExecTarget {
  return project.infrastructureType === "shared"
    ? { container: `sb-${project.ref}-db-1`, user: "postgres" }
    : { container: "supabase-db", user: "supabase_admin" };
}

function ec2InstanceId(project: Project): string {
  const id = (project.connection as { instanceId?: string } | null)?.instanceId;
  if (!id) throw new Error(`Dedicated project ${project.ref} has no recorded instance id`);
  return id;
}

async function ec2Ssm(project: Project): Promise<SSMClient> {
  const creds = await getCredentials(project.organizationId);
  return new SSMClient({
    region: project.region ?? "us-east-1",
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
  });
}

/** Run a SQL script (writes) against the project's database. Throws on error. */
export async function execProjectSql(project: Project, sql: string): Promise<void> {
  const { container, user } = targetFor(project);

  if (project.infrastructureType === "shared") {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", [
        "exec", "-i", container, "psql", "-U", user, "-d", "postgres", "-v", "ON_ERROR_STOP=1",
      ]);
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(stderr.slice(0, 400) || `psql exited ${code}`))
      );
      child.stdin.write(sql);
      child.stdin.end();
    });
    return;
  }

  // EC2: feed the SQL to a remote `docker exec` via base64 (same approach reconfigure uses
  // for the .env write — keeps arbitrary SQL safe through the shell + SSM).
  const b64 = Buffer.from(sql, "utf8").toString("base64");
  const cmd = `echo ${b64} | base64 -d | docker exec -i ${container} psql -U ${user} -d postgres -v ON_ERROR_STOP=1`;
  const ssm = await ec2Ssm(project);
  await runCommand(ssm, ec2InstanceId(project), cmd);
}

/** Run a read-only SQL query and return raw stdout (`-t -A`). Empty string on failure. */
export async function queryProjectSql(project: Project, sql: string): Promise<string> {
  const { container, user } = targetFor(project);

  if (project.infrastructureType === "shared") {
    return new Promise<string>((resolve) => {
      const child = spawn("docker", [
        "exec", container, "psql", "-U", user, "-d", "postgres", "-t", "-A", "-c", sql,
      ]);
      let out = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.on("error", () => resolve(""));
      child.on("close", () => resolve(out));
    });
  }

  const cmd = `docker exec ${container} psql -U ${user} -d postgres -t -A -c ${JSON.stringify(sql)}`;
  const ssm = await ec2Ssm(project);
  return runCommand(ssm, ec2InstanceId(project), cmd).catch(() => "");
}
