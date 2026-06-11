import { randomInt } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { project, projectSecrets, type Project } from "../db/schema";
import { encrypt } from "../crypto/secrets";
import { isKnownRegion, isEc2Region } from "../regions";
import { hasValidCredentials } from "../aws/credentials-service";
import { getQueue } from "../jobs/queue";
import { AppError } from "../http/error";
import { getProvisionerFor } from "./provisioner";
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

// Change a dedicated project's compute size (resize its instance). Floors at medium.
export async function resizeProject(ref: string, computeSize: string): Promise<void> {
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  if (row.infrastructureType === "shared") {
    throw new AppError(400, "not_dedicated", "Compute resize is only available for dedicated (AWS EC2) projects");
  }
  const size = MIN_DEDICATED_COMPUTE.has(computeSize) ? computeSize : "medium";
  await db.update(project).set({ computeSize: size, updatedAt: new Date() }).where(eq(project.ref, ref));
  await getQueue().enqueue("resize_compute", { ref });
}

// Current resource usage. EC2 -> CloudWatch (CPU); shared -> handled by the BFF
// (local docker stats). Returns { infra } so the BFF knows which path to use.
export async function getProjectMetrics(ref: string) {
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  if (row.infrastructureType === "shared") return { infra: "shared" as const };
  const p = getProvisionerFor(row);
  const m = p.getMetrics ? await p.getMetrics(row) : { cpuPercent: 0, ramUsed: 0, ramTotal: 0, diskUsed: 0, diskSize: 0 };
  return { infra: "ec2" as const, ...m };
}

// Read a dedicated project's disk (EBS) config live from AWS.
export async function getProjectDisk(ref: string) {
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  if (row.infrastructureType === "shared") {
    throw new AppError(400, "not_dedicated", "Disk settings are only available for dedicated (AWS EC2) projects");
  }
  const p = getProvisionerFor(row);
  if (!p.getDiskConfig) throw new AppError(400, "unsupported", "Disk config not supported");
  return p.getDiskConfig(row);
}

// Apply a new disk (EBS) config to a dedicated project (online ModifyVolume).
export async function resizeProjectDisk(
  ref: string,
  cfg: { sizeGb: number; iops: number; throughput: number; type: string }
): Promise<void> {
  const row = await getProjectByRef(ref);
  if (!row) throw new AppError(404, "project_not_found", "Project not found");
  if (row.infrastructureType === "shared") {
    throw new AppError(400, "not_dedicated", "Disk settings are only available for dedicated (AWS EC2) projects");
  }
  const p = getProvisionerFor(row);
  if (!p.resizeDisk) throw new AppError(400, "unsupported", "Disk resize not supported");
  // gp3 bounds (AWS): 1–16384 GiB, 3000–16000 IOPS, 125–1000 MB/s throughput.
  const sizeGb = Math.max(8, Math.min(16384, Math.floor(cfg.sizeGb)));
  const iops = Math.max(3000, Math.min(16000, Math.floor(cfg.iops)));
  const throughput = Math.max(125, Math.min(1000, Math.floor(cfg.throughput)));
  await p.resizeDisk(row, { sizeGb, iops, throughput, type: cfg.type || "gp3" });
}

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

