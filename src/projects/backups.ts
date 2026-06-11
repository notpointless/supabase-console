import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getEnv } from "../config/env";
import { decrypt } from "../crypto/secrets";
import type { Project } from "../db/schema";

// [console fork] Logical daily backups. Each backup is a `pg_dump -Fc` of the project's
// database, stored under DATA_DIR/backups/<ref>/; the id is the backup's epoch-ms timestamp
// (stable + sortable). Shared projects dump via `docker exec` into the local db container;
// dedicated (EC2) projects dump over TCP from the instance (5432 is open in the stack SG)
// using a transient postgres client container on the control plane — the dump streams to the
// same local file, so listing/download/restore are identical across infra.

// pg client image used to dump/restore a dedicated project's Postgres over TCP.
const PG_CLIENT_IMAGE = "postgres:15";

function ec2Host(project: Project): string {
  const host = (project.connection as { host?: string } | null)?.host;
  if (!host) throw new Error(`Project ${project.ref} has no reachable host for backup`);
  return host;
}

// Build the `docker` argv for pg_dump (shared: exec into the container; EC2: run a client
// container that connects to the instance over TCP).
function pgDumpArgs(project: Project): string[] {
  if (project.infrastructureType === "shared") {
    return ["exec", `sb-${project.ref}-db-1`, "pg_dump", "-U", "postgres", "-Fc", "postgres"];
  }
  return [
    "run", "--rm", "-e", `PGPASSWORD=${decrypt(project.dbPasswordEncrypted)}`, PG_CLIENT_IMAGE,
    "pg_dump", "-h", ec2Host(project), "-p", "5432", "-U", "postgres", "-Fc", "postgres",
  ];
}

// Build the `docker` argv for pg_restore (reads the dump on stdin).
function pgRestoreArgs(project: Project): string[] {
  const restore = ["pg_restore", "-U", "postgres", "-d", "postgres", "--clean", "--if-exists", "--no-owner", "--no-acl"];
  if (project.infrastructureType === "shared") {
    return ["exec", "-i", `sb-${project.ref}-db-1`, ...restore];
  }
  return [
    "run", "--rm", "-i", "-e", `PGPASSWORD=${decrypt(project.dbPasswordEncrypted)}`, PG_CLIENT_IMAGE,
    "pg_restore", "-h", ec2Host(project), "-p", "5432", "-U", "postgres", "-d", "postgres",
    "--clean", "--if-exists", "--no-owner", "--no-acl",
  ];
}

export interface BackupInfo {
  id: number;
  inserted_at: string;
  isPhysicalBackup: boolean;
  project_id: number;
  status: "COMPLETED" | "FAILED" | "PENDING";
}

function backupsDir(ref: string): string {
  return join(getEnv().DATA_DIR, "backups", ref);
}

export function listBackups(ref: string): BackupInfo[] {
  const dir = backupsDir(ref);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".dump"))
    .map((f) => {
      const ts = Number(f.replace(".dump", ""));
      const ms = Number.isFinite(ts) ? ts : statSync(join(dir, f)).mtimeMs;
      return {
        id: Math.floor(ms),
        inserted_at: new Date(ms).toISOString(),
        isPhysicalBackup: false,
        project_id: 0,
        status: "COMPLETED" as const,
      };
    })
    .sort((a, b) => b.id - a.id);
}

export function backupFilePath(ref: string, id: number): string | null {
  const file = join(backupsDir(ref), `${id}.dump`);
  return existsSync(file) ? file : null;
}

// `pg_dump -Fc` the project's database (shared: local container; EC2: over TCP) to a file.
export async function createBackup(project: Project): Promise<BackupInfo> {
  const dir = backupsDir(project.ref);
  mkdirSync(dir, { recursive: true });
  const ts = Date.now();
  const file = join(dir, `${ts}.dump`);

  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(file);
    const child = spawn("docker", pgDumpArgs(project));
    let stderr = "";
    child.stdout.pipe(out);
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      out.close();
      if (code === 0) resolve();
      else reject(new Error(`pg_dump exited ${code}: ${stderr.slice(0, 300)}`));
    });
  });

  return {
    id: ts,
    inserted_at: new Date(ts).toISOString(),
    isPhysicalBackup: false,
    project_id: 0,
    status: "COMPLETED",
  };
}

// Restore a logical backup (pg_dump -Fc) into the project's database via pg_restore.
// --clean drops + recreates objects first. pg_restore commonly exits 1 on benign
// warnings (e.g. dropping objects that don't exist yet), so 0 and 1 both count as ok.
export async function restoreBackup(project: Project, id: number): Promise<void> {
  const file = backupFilePath(project.ref, id);
  if (!file) throw new Error("Backup not found");

  await new Promise<void>((resolve, reject) => {
    const child = spawn("docker", pgRestoreArgs(project));
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || code === 1) resolve();
      else reject(new Error(`pg_restore exited ${code}: ${stderr.slice(0, 400)}`));
    });
    createReadStream(file).pipe(child.stdin);
  });
}
