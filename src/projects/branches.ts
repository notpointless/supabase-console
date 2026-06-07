import { randomBytes, randomInt } from "node:crypto";
import { spawn } from "node:child_process";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { project, projectSecrets, type Project } from "../db/schema";
import { encrypt } from "../crypto/secrets";
import { generateProjectSecrets, encryptedSecretColumns } from "./secrets";
import { getProjectByRef } from "./service";
import { getQueue } from "../jobs/queue";
import { AppError } from "../http/error";

// ---------------------------------------------------------------------------
// Preview branches.
//
// A branch is a *child project*: its own isolated stack (kong/db/etc., own ports
// + secrets), seeded from the parent's database. We reuse the whole project
// machinery (provisioner, ports, teardown) and just link the row to its parent
// via `parentProjectId`. The production project is the implicit "main" branch.
//
// Branch lifecycle: createBranch() inserts a `provisioning` child + enqueues
// `provision_branch`, which provisions the stack then seeds the schema (and data,
// if requested) from the parent via `pg_dump | psql` across the two db containers.
// ---------------------------------------------------------------------------

function generateRef(): string {
  let s = "";
  for (let i = 0; i < 20; i++) s += String.fromCharCode(97 + randomInt(26));
  return s;
}

export interface CreateBranchInput {
  parentRef: string;
  branchName: string;
  gitBranch?: string | null;
  withData?: boolean;
  createdBy: string;
}

/** Map our project status to the dashboard's branch status enum. */
function branchStatus(status: string): string {
  switch (status) {
    case "provisioning":
      return "CREATING_PROJECT";
    case "active":
      return "MIGRATIONS_PASSED";
    case "failed":
      return "MIGRATIONS_FAILED";
    case "paused":
      return "MIGRATIONS_PASSED";
    default:
      return "CREATING_PROJECT";
  }
}

/** Shape a project row into the dashboard's BranchResponse. */
export function mapBranch(row: Project, parentRef: string, isDefault = false) {
  return {
    id: row.id,
    name: isDefault ? "main" : row.name,
    project_ref: row.ref,
    parent_project_ref: parentRef,
    is_default: isDefault,
    persistent: isDefault,
    status: isDefault ? "MIGRATIONS_PASSED" : branchStatus(row.status),
    git_branch: row.gitBranch ?? undefined,
    pr_number: undefined,
    latest_check_run_id: undefined,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function getBranchById(id: string): Promise<Project | undefined> {
  const [row] = await db.select().from(project).where(eq(project.id, id));
  return row;
}

/**
 * List branches for a project: the parent itself as the default ("main") branch
 * plus every child preview branch.
 */
export async function listBranches(parentRef: string) {
  const parent = await getProjectByRef(parentRef);
  if (!parent) throw new AppError(404, "project_not_found", "Project not found");
  // If `parentRef` is itself a branch, branches are listed against its parent.
  const rootId = parent.parentProjectId ?? parent.id;
  const root = parent.parentProjectId
    ? (await getBranchById(parent.parentProjectId))!
    : parent;
  const children = await db
    .select()
    .from(project)
    .where(eq(project.parentProjectId, rootId));
  return [mapBranch(root, root.ref, true), ...children.map((c) => mapBranch(c, root.ref))];
}

export async function createBranch(input: CreateBranchInput): Promise<Project> {
  const parent = await getProjectByRef(input.parentRef);
  if (!parent) throw new AppError(404, "project_not_found", "Project not found");
  if (parent.parentProjectId) {
    throw new AppError(400, "cannot_branch_branch", "Cannot create a branch of a branch");
  }
  if (parent.infrastructureType !== "shared") {
    // Branching a dedicated/EC2 project would mean launching another instance —
    // deferred. Shared-infra (Docker) branches are supported.
    throw new AppError(400, "branch_unsupported_infra", "Preview branches are only supported on shared infrastructure");
  }
  const ref = generateRef();
  const secrets = await generateProjectSecrets();
  const dbPassword = randomBytes(18).toString("base64url");
  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(project)
      .values({
        ref,
        organizationId: parent.organizationId,
        name: input.branchName,
        region: parent.region,
        infrastructureType: parent.infrastructureType,
        postgresType: parent.postgresType,
        status: "provisioning",
        dataApiEnabled: parent.dataApiEnabled,
        autoExposeNewTables: parent.autoExposeNewTables,
        autoEnableRls: parent.autoEnableRls,
        dbPasswordEncrypted: encrypt(dbPassword),
        parentProjectId: parent.id,
        gitBranch: input.gitBranch ?? null,
        createdBy: input.createdBy,
      })
      .returning();
    await tx.insert(projectSecrets).values(encryptedSecretColumns(row!.id, secrets));
  });
  await getQueue().enqueue("provision_branch", { ref, withData: !!input.withData });
  return (await getProjectByRef(ref))!;
}

export async function deleteBranch(id: string): Promise<void> {
  const row = await getBranchById(id);
  if (!row) throw new AppError(404, "branch_not_found", "Branch not found");
  if (!row.parentProjectId) {
    throw new AppError(400, "not_a_branch", "This project is not a preview branch");
  }
  await db.update(project).set({ status: "removing", updatedAt: new Date() }).where(eq(project.id, id));
  await getQueue().enqueue("delete", { ref: row.ref });
}

/** Re-seed a branch's database from its parent (drops + recopies the public schema). */
export async function resetBranch(id: string, withData = false): Promise<void> {
  const row = await getBranchById(id);
  if (!row) throw new AppError(404, "branch_not_found", "Branch not found");
  if (!row.parentProjectId) throw new AppError(400, "not_a_branch", "This project is not a preview branch");
  await getQueue().enqueue("seed_branch", { ref: row.ref, withData });
}

/**
 * Seed a branch's database from its parent: dump the parent's `public` schema
 * (schema only, or schema+data) and load it into the branch. Both databases run
 * in their own Docker containers (`sb-<ref>-db-1`).
 */
export async function seedBranchFromParent(branch: Project, withData: boolean): Promise<void> {
  if (!branch.parentProjectId) throw new Error("project is not a branch");
  const [parent] = await db.select().from(project).where(eq(project.id, branch.parentProjectId));
  if (!parent) throw new Error("parent project not found");

  const dumpArgs = [
    "exec",
    `sb-${parent.ref}-db-1`,
    "pg_dump",
    "-U",
    "postgres",
    "--schema=public",
    "--no-owner",
    "--no-acl",
    "--clean",
    "--if-exists",
    ...(withData ? [] : ["--schema-only"]),
    "postgres",
  ];

  await new Promise<void>((resolve, reject) => {
    const dump = spawn("docker", dumpArgs);
    const restore = spawn("docker", [
      "exec",
      "-i",
      `sb-${branch.ref}-db-1`,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=0",
    ]);
    let stderr = "";
    dump.stdout.pipe(restore.stdin);
    dump.stderr.on("data", (d) => (stderr += `[pg_dump] ${d}`));
    restore.stderr.on("data", (d) => (stderr += `[psql] ${d}`));
    dump.on("error", reject);
    restore.on("error", reject);
    restore.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`branch seed failed (psql ${code}): ${stderr.slice(0, 400)}`));
    });
  });
}
