import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { project, projectRepoConnection, orgGithubConnection, type Project } from "../db/schema";
import { decrypt } from "../crypto/secrets";
import { AppError } from "../http/error";
import { execProjectSql, queryProjectSql } from "../projects/db-exec";

// ---------------------------------------------------------------------------
// GitHub deploy pipeline (self-host).
//
// Connects a project to a GitHub repo+branch and applies that repo's
// `supabase/migrations/*.sql` to the project's database — the core of Supabase's
// branching/CI deploy flow, minus the hosted GitHub App. Auth uses the org's
// stored GitHub token (a PAT works); public repos need no token. Triggered
// manually (POST .../github/deploy) or by a push webhook when the backend is
// publicly reachable. Applied migrations are tracked in
// `supabase_migrations.schema_migrations` so re-deploys are idempotent.
// ---------------------------------------------------------------------------

const GITHUB_API = "https://api.github.com";

export interface RepoConnection {
  repoFullName: string;
  branch: string;
}

function parseRepo(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) throw new AppError(400, "invalid_repo", "Repository must be in 'owner/repo' form");
  return { owner, repo };
}

async function githubToken(organizationId: string): Promise<string | undefined> {
  const [conn] = await db
    .select({ tok: orgGithubConnection.accessTokenEncrypted })
    .from(orgGithubConnection)
    .where(eq(orgGithubConnection.organizationId, organizationId));
  return conn?.tok ? decrypt(conn.tok) : undefined;
}

function ghHeaders(token?: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "supabase-console",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export interface RepoMigration {
  version: string; // leading numeric/timestamp portion of the filename
  name: string; // full filename
  sql: string;
}

/** Fetch + sort `supabase/migrations/*.sql` from a repo at a ref. */
export async function fetchMigrations(
  repoFullName: string,
  branch: string,
  token?: string
): Promise<RepoMigration[]> {
  const { owner, repo } = parseRepo(repoFullName);
  const listUrl = `${GITHUB_API}/repos/${owner}/${repo}/contents/supabase/migrations?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(listUrl, { headers: ghHeaders(token) });
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new AppError(res.status === 401 || res.status === 403 ? 400 : 502, "github_error", `GitHub API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const entries = (await res.json()) as Array<{ name: string; type: string; download_url: string | null }>;
  const files = entries
    .filter((e) => e.type === "file" && e.name.endsWith(".sql") && e.download_url)
    .sort((a, b) => a.name.localeCompare(b.name));

  const migrations: RepoMigration[] = [];
  for (const f of files) {
    const dl = await fetch(f.download_url!, { headers: ghHeaders(token) });
    if (!dl.ok) throw new AppError(502, "github_error", `Failed to download ${f.name}: ${dl.status}`);
    const sql = await dl.text();
    const version = f.name.match(/^(\d+)/)?.[1] ?? f.name.replace(/\.sql$/, "");
    migrations.push({ version, name: f.name, sql });
  }
  return migrations;
}

/** Read the set of already-applied migration versions from the project DB. */
async function appliedVersionsFor(target: Project): Promise<Set<string>> {
  const out = await queryProjectSql(
    target,
    "select version from supabase_migrations.schema_migrations"
  );
  return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
}

export interface DeployResult {
  repo: string;
  branch: string;
  applied: string[];
  skipped: string[];
}

/** Core: apply a repo's migrations to a target project's DB (idempotent). Works on shared
 *  and dedicated (EC2) infra — the SQL runs via the infra-aware db-exec primitive. */
async function applyRepoMigrations(
  target: Project,
  repoFullName: string,
  branch: string,
  token?: string
): Promise<DeployResult> {
  const migrations = await fetchMigrations(repoFullName, branch, token);

  // Ensure the migrations bookkeeping table exists.
  await execProjectSql(
    target,
    `create schema if not exists supabase_migrations;
     create table if not exists supabase_migrations.schema_migrations (version text primary key, name text, statements text[], inserted_at timestamptz default now());`
  );
  const applied = await appliedVersionsFor(target);

  const didApply: string[] = [];
  const skipped: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.version)) {
      skipped.push(m.name);
      continue;
    }
    // Apply the migration and record it in the same transaction.
    const stmt = `begin;\n${m.sql}\n;\ninsert into supabase_migrations.schema_migrations(version, name) values (${quote(m.version)}, ${quote(m.name)}) on conflict (version) do nothing;\ncommit;`;
    await execProjectSql(target, stmt);
    didApply.push(m.name);
  }
  return { repo: repoFullName, branch, applied: didApply, skipped };
}

/** Apply a project's connected repo migrations to its own database (idempotent). */
export async function deployProject(ref: string): Promise<DeployResult> {
  const [proj] = await db.select().from(project).where(eq(project.ref, ref));
  if (!proj) throw new AppError(404, "project_not_found", "Project not found");
  const [conn] = await db
    .select()
    .from(projectRepoConnection)
    .where(eq(projectRepoConnection.projectId, proj.id));
  if (!conn) throw new AppError(400, "no_repo_connection", "No GitHub repository is connected to this project");

  const token = await githubToken(proj.organizationId);
  return applyRepoMigrations(proj, conn.repoFullName, conn.branch ?? "main", token);
}

/**
 * Merge a preview branch into production: apply the branch's tracked Git-branch
 * migrations to the PARENT (production) project. Requires the branch to track a
 * repo (its own project_repo_connection, set when the branch was created from a
 * PR). For branches without a repo link, merge via the Git provider instead.
 */
export async function mergeBranchToProduction(branchId: string): Promise<DeployResult> {
  const [branch] = await db.select().from(project).where(eq(project.id, branchId));
  if (!branch) throw new AppError(404, "branch_not_found", "Branch not found");
  if (!branch.parentProjectId) throw new AppError(400, "not_a_branch", "This project is not a preview branch");
  const [parent] = await db.select().from(project).where(eq(project.id, branch.parentProjectId));
  if (!parent) throw new AppError(404, "project_not_found", "Parent project not found");
  const [conn] = await db
    .select()
    .from(projectRepoConnection)
    .where(eq(projectRepoConnection.projectId, branch.id));
  if (!conn) {
    throw new AppError(
      400,
      "branch_not_tracked",
      "This branch isn't linked to a Git branch. Merge it through your Git provider, or connect a repo."
    );
  }
  const token = await githubToken(parent.organizationId);
  return applyRepoMigrations(parent, conn.repoFullName, conn.branch ?? "main", token);
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Supabase-style UTC migration version (YYYYMMDDHHMMSS). */
function migrationVersion(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/**
 * Push a preview branch's schema changes back to its tracked Git branch: diff the
 * branch's DB against its parent and commit the result as a new
 * `supabase/migrations/<version>_<ref>.sql` file via the GitHub contents API. This is
 * the inverse of the deploy flow (which applies repo migrations to a DB). Requires the
 * branch to track a repo and an org GitHub token with `contents:write`.
 */
export async function pushBranchToGit(
  branchId: string
): Promise<{ repo: string; branch: string; file: string }> {
  const [branch] = await db.select().from(project).where(eq(project.id, branchId));
  if (!branch) throw new AppError(404, "branch_not_found", "Branch not found");
  const [conn] = await db
    .select()
    .from(projectRepoConnection)
    .where(eq(projectRepoConnection.projectId, branch.id));
  if (!conn) {
    throw new AppError(
      400,
      "branch_not_tracked",
      "This branch isn't linked to a Git branch. Connect a repo to push its changes."
    );
  }
  const token = await githubToken(branch.organizationId);
  if (!token) {
    throw new AppError(
      400,
      "no_github_token",
      "Connect a GitHub account with write access to this repo before pushing."
    );
  }

  // The branch's schema diff vs its parent — the migration we commit.
  const { branchSchemaDiff } = await import("../projects/branches.js");
  const diff = (await branchSchemaDiff(branch.id)).trim();
  if (!diff) throw new AppError(400, "no_changes", "No schema changes to push.");

  const { owner, repo } = parseRepo(conn.repoFullName);
  const gitBranch = conn.branch ?? "main";
  const safeRef = branch.ref.replace(/[^a-z0-9_]/gi, "_");
  const file = `${migrationVersion()}_${safeRef}.sql`;
  const path = `supabase/migrations/${file}`;
  const body = `-- Pushed from preview branch ${branch.name} (${branch.ref})\n${diff}\n`;
  const content = Buffer.from(body, "utf8").toString("base64");

  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
    method: "PUT",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `chore(db): migration from preview branch ${branch.name}`,
      content,
      branch: gitBranch,
    }),
  });
  if (!res.ok) {
    throw new AppError(
      res.status === 401 || res.status === 403 ? 400 : 502,
      "github_error",
      `GitHub API ${res.status}: ${(await res.text()).slice(0, 200)}`
    );
  }
  return { repo: conn.repoFullName, branch: gitBranch, file };
}

// --- repo connection management ---------------------------------------------

export async function getRepoConnection(projectId: string) {
  const [conn] = await db.select().from(projectRepoConnection).where(eq(projectRepoConnection.projectId, projectId));
  return conn ?? null;
}

export async function setRepoConnection(proj: Project, repoFullName: string, branch: string) {
  parseRepo(repoFullName); // validate shape
  await db.delete(projectRepoConnection).where(eq(projectRepoConnection.projectId, proj.id));
  const [conn] = await db
    .insert(projectRepoConnection)
    .values({ projectId: proj.id, repoFullName, branch })
    .returning();
  return conn!;
}

export async function deleteRepoConnection(projectId: string) {
  await db.delete(projectRepoConnection).where(eq(projectRepoConnection.projectId, projectId));
}
