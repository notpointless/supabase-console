import { randomInt } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
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
  computeSize?: string;
  dataApiEnabled?: boolean;
  autoExposeNewTables?: boolean;
  autoEnableRls?: boolean;
  createdBy: string;
}

// Dedicated projects need >=4GB; never accept a tier the stack can't run on.
const MIN_DEDICATED_COMPUTE = new Set(["medium", "large", "xlarge", "2xlarge", "4xlarge", "8xlarge", "12xlarge", "16xlarge"]);

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
  // Floor the dedicated tier at "medium" (4GB) — micro/small can't run the stack.
  const computeSize =
    infrastructureType === "dedicated_ec2" && !MIN_DEDICATED_COMPUTE.has(input.computeSize ?? "")
      ? "medium"
      : (input.computeSize ?? "medium");
  const ref = generateRef();
  const secrets = await generateProjectSecrets();
  await db.transaction(async (tx) => {
    const [row] = await tx.insert(project).values({
      ref,
      organizationId: input.organizationId,
      name: input.name,
      region: input.region,
      infrastructureType,
      computeSize,
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
  // Exclude preview branches — they're child projects surfaced via the branches
  // API + branch selector, not as standalone projects in the org's project grid.
  return db
    .select()
    .from(project)
    .where(and(eq(project.organizationId, organizationId), isNull(project.parentProjectId)));
}

export async function pauseProject(ref: string): Promise<void> {
  await getQueue().enqueue("pause", { ref });
}

export async function resumeProject(ref: string): Promise<void> {
  await getQueue().enqueue("resume", { ref });
}

// Map the dashboard's logical service names to our compose service names.
const SERVICE_NAME_MAP: Record<string, string> = {
  postgresql: "db",
  database: "db",
  db: "db",
  postgrest: "rest",
  rest: "rest",
  api: "rest",
  gotrue: "auth",
  auth: "auth",
  pgbouncer: "supavisor",
  pooler: "supavisor",
  supavisor: "supavisor",
  realtime: "realtime",
  storage: "storage",
  functions: "functions",
  meta: "meta",
  kong: "kong",
};

export async function restartProject(ref: string, services?: string[]): Promise<void> {
  const mapped = (services ?? [])
    .map((s) => SERVICE_NAME_MAP[s.toLowerCase()] ?? s)
    .filter((s, i, a) => a.indexOf(s) === i);
  await getQueue().enqueue("restart", { ref, services: mapped });
}

export async function deleteProject(ref: string): Promise<void> {
  await db.update(project).set({ status: "removing", updatedAt: new Date() }).where(eq(project.ref, ref));
  await getQueue().enqueue("delete", { ref });
}

