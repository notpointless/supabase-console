import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getEnv } from "../config/env";
import type { Project } from "../db/schema";

// [console fork] Logical daily backups for shared-infra projects. Each backup is a
// `pg_dump -Fc` of the project's database, stored under DATA_DIR/backups/<ref>/. The
// id is the backup's epoch-ms timestamp (stable + sortable). EC2/dedicated projects
// back up on their own host and are out of scope here.

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

// Run `pg_dump` inside the project's db container and stream it to a file.
export async function createBackup(project: Project): Promise<BackupInfo> {
  if (project.infrastructureType !== "shared") {
    throw new Error("Backups are only managed for shared-infrastructure projects");
  }
  const dir = backupsDir(project.ref);
  mkdirSync(dir, { recursive: true });
  const ts = Date.now();
  const file = join(dir, `${ts}.dump`);

  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(file);
    const child = spawn("docker", [
      "exec",
      `sb-${project.ref}-db-1`,
      "pg_dump",
      "-U",
      "postgres",
      "-Fc",
      "postgres",
    ]);
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
