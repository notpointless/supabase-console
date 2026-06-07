import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { projectFunctionSecret } from "../db/schema";
import type { Project } from "../db/schema";
import { encrypt, decrypt } from "../crypto/secrets";
import { projectDir } from "./stack/writer";

export interface SecretInput {
  name: string;
  value: string;
}

export async function listFunctionSecrets(
  projectId: string
): Promise<Array<{ name: string; value: string; updated_at: string }>> {
  const rows = await db
    .select()
    .from(projectFunctionSecret)
    .where(eq(projectFunctionSecret.projectId, projectId));
  return rows.map((r) => ({ name: r.name, value: decrypt(r.valueEncrypted), updated_at: r.updatedAt.toISOString() }));
}

export async function setFunctionSecrets(project: Project, secrets: SecretInput[]): Promise<void> {
  for (const s of secrets) {
    await db
      .insert(projectFunctionSecret)
      .values({ projectId: project.id, name: s.name, valueEncrypted: encrypt(s.value) })
      .onConflictDoUpdate({
        target: [projectFunctionSecret.projectId, projectFunctionSecret.name],
        set: { valueEncrypted: encrypt(s.value), updatedAt: new Date() },
      });
  }
  await writeSecretsFile(project);
}

export async function deleteFunctionSecrets(project: Project, names: string[]): Promise<void> {
  for (const n of names) {
    await db
      .delete(projectFunctionSecret)
      .where(and(eq(projectFunctionSecret.projectId, project.id), eq(projectFunctionSecret.name, n)));
  }
  await writeSecretsFile(project);
}

// Write the decrypted secrets to the functions volume's .secrets.json. The main
// router merges this into every function's env per-request (live, no restart).
async function writeSecretsFile(project: Project): Promise<void> {
  // Only the local shared docker stack has a host-writable functions volume.
  // (EC2 projects keep secrets on the remote host — handled by reconfigure.)
  if (project.infrastructureType !== "shared") return;
  const rows = await db
    .select()
    .from(projectFunctionSecret)
    .where(eq(projectFunctionSecret.projectId, project.id));
  const obj: Record<string, string> = {};
  for (const r of rows) obj[r.name] = decrypt(r.valueEncrypted);
  const dir = join(projectDir(project.ref), "volumes", "functions");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".secrets.json"), JSON.stringify(obj), "utf8");
}
