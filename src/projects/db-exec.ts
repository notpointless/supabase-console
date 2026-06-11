import { spawn } from "node:child_process";
import { SSMClient } from "@aws-sdk/client-ssm";
import type { Project } from "../db/schema";
import { getCredentials } from "../aws/credentials-service";
import { decrypt } from "../crypto/secrets";
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

// Single-quote a value for safe inclusion in a remote shell command.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * pg_dump a project's `public` schema. Shared: local docker exec. EC2: SSM docker exec, whose
 * captured stdout SSM truncates at ~24KB — fine for typical schema diffs, but a very large
 * schema-only dump may be cut. Used for the branch schema diff.
 */
export async function dumpProjectSchema(project: Project): Promise<string> {
  const { container, user } = targetFor(project);
  const flags = "--schema=public --schema-only --no-owner --no-acl --no-comments";
  if (project.infrastructureType === "shared") {
    return new Promise<string>((resolve, reject) => {
      const child = spawn("docker", [
        "exec", container, "pg_dump", "-U", user, ...flags.split(" "), "postgres",
      ]);
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve(out) : reject(new Error(err.slice(0, 300) || `pg_dump exited ${code}`))
      );
    });
  }
  const ssm = await ec2Ssm(project);
  return runCommand(
    ssm,
    ec2InstanceId(project),
    `docker exec ${container} pg_dump -U ${user} ${flags} postgres`
  );
}

/**
 * Wait until a project's Postgres accepts connections. Shared projects are brought up by
 * compose.up (already waited), so this is a no-op; an EC2 instance returns from provision once
 * the host is reachable but the stack may still be starting under cloud-init, so we poll
 * pg_isready over SSM before seeding a fresh branch.
 */
export async function waitForDbReady(project: Project, attempts = 48): Promise<void> {
  if (project.infrastructureType === "shared") return;
  const { container, user } = targetFor(project);
  const ssm = await ec2Ssm(project);
  const instanceId = ec2InstanceId(project);
  for (let i = 0; i < attempts; i++) {
    const out = await runCommand(
      ssm,
      instanceId,
      `docker exec ${container} pg_isready -U ${user} -d postgres || true`
    ).catch(() => "");
    if (out.includes("accepting connections")) return;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`Postgres on ${project.ref} did not become ready in time`);
}

/**
 * Seed a dedicated (EC2) branch's database from its parent. Runs a single SSM script on the
 * BRANCH instance: pg_dump connects out to the parent's Postgres over TCP (5432 is open in the
 * stack SG) and pipes straight into a local restore — the dump is never captured by SSM, so
 * there's no output-size limit. The parent DB password rides in the script via PGPASSWORD (the
 * same way reconfigure passes stack secrets over SSM). External TCP auth uses the `postgres`
 * superuser; the local restore uses `supabase_admin` (the in-container superuser).
 */
export async function seedBranchFromParentEc2(
  parent: Project,
  branch: Project,
  withData: boolean
): Promise<void> {
  const parentHost = (parent.connection as { host?: string } | null)?.host;
  if (!parentHost) throw new Error(`Parent ${parent.ref} has no host for a cross-instance seed`);

  await waitForDbReady(branch);

  const parentPw = decrypt(parent.dbPasswordEncrypted);
  const { container, user } = targetFor(branch); // supabase-db / supabase_admin
  const dumpFlags = [
    "--schema=public", "--no-owner", "--no-acl", "--clean", "--if-exists",
    ...(withData ? [] : ["--schema-only"]),
  ].join(" ");

  const script =
    `docker exec -e PGPASSWORD=${shellQuote(parentPw)} ${container} ` +
    `pg_dump -h ${parentHost} -p 5432 -U postgres -d postgres ${dumpFlags} ` +
    `| docker exec -i ${container} psql -U ${user} -d postgres -v ON_ERROR_STOP=0`;

  const ssm = await ec2Ssm(branch);
  await runCommand(ssm, ec2InstanceId(branch), script);
}
