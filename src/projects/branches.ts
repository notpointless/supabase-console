import { randomBytes, randomInt } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { project, projectSecrets, projectRepoConnection, type Project } from "../db/schema";
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

/**
 * GitHub sync: keep preview branches in lock-step with a repo's pull requests.
 * On PR opened, create a preview branch for the PR's head branch on every
 * production project connected to that repo — and give the branch its own repo
 * connection so the push webhook then deploys the PR's migrations to it. On PR
 * closed, tear the branch down. Returns a per-project summary.
 */
export async function syncPullRequestBranch(
  repoFullName: string,
  action: string,
  gitBranch: string
): Promise<Array<{ project: string; action: string; branch?: string }>> {
  // Production projects connected to this repo (a branch's own connection has the
  // PR head ref as its branch; we only fan out from production projects here).
  const conns = await db
    .select()
    .from(projectRepoConnection)
    .where(eq(projectRepoConnection.repoFullName, repoFullName));
  const results: Array<{ project: string; action: string; branch?: string }> = [];

  for (const conn of conns) {
    const [prod] = await db.select().from(project).where(eq(project.id, conn.projectId));
    if (!prod || prod.parentProjectId) continue; // only fan out from production projects
    const [existing] = await db
      .select()
      .from(project)
      .where(and(eq(project.parentProjectId, prod.id), eq(project.gitBranch, gitBranch)));

    if (action === "opened" || action === "reopened") {
      if (existing) {
        results.push({ project: prod.ref, action: "exists", branch: existing.ref });
        continue;
      }
      const branch = await createBranch({
        parentRef: prod.ref,
        branchName: gitBranch,
        gitBranch,
        withData: false,
        createdBy: prod.createdBy,
      });
      // Give the branch its own repo connection so push→deploy targets it.
      await db
        .insert(projectRepoConnection)
        .values({ projectId: branch.id, repoFullName, branch: gitBranch });
      results.push({ project: prod.ref, action: "created", branch: branch.ref });
    } else if (action === "closed") {
      if (existing) {
        await deleteBranch(existing.id);
        results.push({ project: prod.ref, action: "deleted", branch: existing.ref });
      }
    }
  }
  return results;
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

/** Dump a project's public schema (DDL only, normalized) for diffing. */
function dumpPublicSchema(ref: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [
      "exec",
      `sb-${ref}-db-1`,
      "pg_dump",
      "-U",
      "postgres",
      "--schema=public",
      "--schema-only",
      "--no-owner",
      "--no-acl",
      "--no-comments",
      "postgres",
    ]);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.slice(0, 300) || `pg_dump exited ${code}`))));
  });
}

/**
 * Schema diff between a preview branch and its parent (production): a unified
 * diff of each side's `public` schema DDL. Empty when identical. Returns "" for a
 * production project (nothing to diff against).
 */
export async function branchSchemaDiff(branchId: string): Promise<string> {
  const branch = await getBranchById(branchId);
  if (!branch) throw new AppError(404, "branch_not_found", "Branch not found");
  if (!branch.parentProjectId) return "";
  const [parent] = await db.select().from(project).where(eq(project.id, branch.parentProjectId));
  if (!parent) throw new AppError(404, "project_not_found", "Parent project not found");

  const [prodSql, branchSql] = await Promise.all([
    dumpPublicSchema(parent.ref),
    dumpPublicSchema(branch.ref),
  ]);
  if (prodSql === branchSql) return "";

  // Unified diff via `git diff --no-index` (robust + already a dependency).
  const dir = mkdtempSync(join(tmpdir(), "branch-diff-"));
  writeFileSync(join(dir, "production.sql"), prodSql);
  writeFileSync(join(dir, "branch.sql"), branchSql);
  return new Promise((resolve) => {
    // Run from the temp dir with relative names so the diff header reads
    // "a/production.sql"/"b/branch.sql" instead of absolute temp paths.
    const git = spawn(
      "git",
      ["--no-pager", "diff", "--no-index", "--no-color", "production.sql", "branch.sql"],
      { cwd: dir }
    );
    let out = "";
    git.stdout.on("data", (d) => (out += d.toString()));
    git.on("error", () => resolve(""));
    git.on("close", () => resolve(out));
  });
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
