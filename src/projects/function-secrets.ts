import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { eq, and } from "drizzle-orm";
import { SSMClient } from "@aws-sdk/client-ssm";
import { db } from "../db/client";
import { projectFunctionSecret } from "../db/schema";
import type { Project } from "../db/schema";
import { encrypt, decrypt } from "../crypto/secrets";
import { getCredentials } from "../aws/credentials-service";
import { projectDir } from "./stack/writer";
import { runCommand } from "./ec2-ssm";

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
  const rows = await db
    .select()
    .from(projectFunctionSecret)
    .where(eq(projectFunctionSecret.projectId, project.id));
  const obj: Record<string, string> = {};
  for (const r of rows) obj[r.name] = decrypt(r.valueEncrypted);
  const json = JSON.stringify(obj);

  if (project.infrastructureType === "shared") {
    // Local docker stack: write straight to the host-mounted functions volume.
    const dir = join(projectDir(project.ref), "volumes", "functions");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".secrets.json"), json, "utf8");
    return;
  }

  // Dedicated (EC2): write the file on the instance over SSM. It mounts into the
  // functions container at /home/deno/functions/.secrets.json (the main router reads
  // it per-request). If the instance isn't recorded yet (still provisioning), skip —
  // the file is seeded again on the next secret change.
  const instanceId = (project.connection as { instanceId?: string } | null)?.instanceId;
  if (!instanceId) return;
  const creds = await getCredentials(project.organizationId);
  const ssm = new SSMClient({
    region: project.region,
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
  });
  const b64 = Buffer.from(json, "utf8").toString("base64");
  await runCommand(
    ssm,
    instanceId,
    `mkdir -p /opt/supabase/docker/volumes/functions && echo ${b64} | base64 -d > /opt/supabase/docker/volumes/functions/.secrets.json`
  );
}
