import { randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { project, projectSecrets, type Project } from "../db/schema";
import { encrypt } from "../crypto/secrets";
import { isKnownRegion, isEc2Region } from "../regions";
import { hasValidCredentials } from "../aws/credentials-service";
import { getQueue } from "../jobs/queue";
import { AppError } from "../http/error";
import { generateProjectSecrets, encryptedSecretColumns } from "./secrets";

function generateRef(): string {
  let s = "";
  for (let i = 0; i < 20; i++) s += String.fromCharCode(97 + randomInt(26));
  return s;
}

export interface CreateProjectInput {
  organizationId: string;
  name: string;
  region: string;
  dbPassword: string;
  postgresType?: "postgres" | "orioledb";
  dataApiEnabled?: boolean;
  autoExposeNewTables?: boolean;
  autoEnableRls?: boolean;
  createdBy: string;
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  if (!isKnownRegion(input.region)) {
    throw new AppError(400, "invalid_region", "Unknown region");
  }
  let infrastructureType = "shared";
  if (isEc2Region(input.region)) {
    if (!(await hasValidCredentials(input.organizationId))) {
      throw new AppError(400, "ec2_unavailable", "EC2 region requires validated AWS credentials");
    }
    infrastructureType = "dedicated_ec2";
  }
  const ref = generateRef();
  const secrets = await generateProjectSecrets();
  await db.transaction(async (tx) => {
    const [row] = await tx.insert(project).values({
      ref,
      organizationId: input.organizationId,
      name: input.name,
      region: input.region,
      infrastructureType,
      postgresType: input.postgresType ?? "postgres",
      status: "provisioning",
      dataApiEnabled: input.dataApiEnabled ?? true,
      autoExposeNewTables: input.autoExposeNewTables ?? true,
      autoEnableRls: input.autoEnableRls ?? true,
      dbPasswordEncrypted: encrypt(input.dbPassword),
      createdBy: input.createdBy,
    }).returning();
    await tx.insert(projectSecrets).values(encryptedSecretColumns(row!.id, secrets));
  });
  await getQueue().enqueue("provision", { ref });
  return (await getProjectByRef(ref))!;
}

export async function getProjectByRef(ref: string): Promise<Project | undefined> {
  const [row] = await db.select().from(project).where(eq(project.ref, ref));
  return row;
}

export async function listProjects(organizationId: string): Promise<Project[]> {
  return db.select().from(project).where(eq(project.organizationId, organizationId));
}

export async function pauseProject(ref: string): Promise<void> {
  await getQueue().enqueue("pause", { ref });
}

export async function resumeProject(ref: string): Promise<void> {
  await getQueue().enqueue("resume", { ref });
}

export async function deleteProject(ref: string): Promise<void> {
  await db.update(project).set({ status: "removing", updatedAt: new Date() }).where(eq(project.ref, ref));
  await getQueue().enqueue("delete", { ref });
}

// Synchronously tear down every project in an org and remove its rows. Used when
// an organization is deleted so no EC2 instance or shared-infra stack is orphaned
// and no project row is left dangling against the about-to-be-deleted org.
export async function deleteAllProjectsForOrg(organizationId: string): Promise<void> {
  const { getProvisionerFor } = await import("./provisioner.js");
  const rows = await db.select().from(project).where(eq(project.organizationId, organizationId));
  for (const p of rows) {
    try {
      await getProvisionerFor(p).delete(p);
    } catch {
      // best-effort teardown; still remove the rows so the org can be deleted.
    }
    await db.delete(projectSecrets).where(eq(projectSecrets.projectId, p.id));
    await db.delete(project).where(eq(project.id, p.id));
  }
}
