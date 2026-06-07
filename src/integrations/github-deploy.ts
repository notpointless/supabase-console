import { spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { project, projectRepoConnection, orgGithubConnection, type Project } from "../db/schema";
import { decrypt } from "../crypto/secrets";
import { AppError } from "../http/error";

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

/** Run SQL inside a shared-infra project's db container via stdin. */
function psql(ref: string, sql: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("docker", [
      "exec",
      "-i",
      `sb-${ref}-db-1`,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
    ]);
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(0, 400) || `psql exited ${code}`))));
    child.stdin.write(sql);
    child.stdin.end();
  });
}

/** Read the set of already-applied migration versions from the project DB. */
async function appliedVersions(ref: string): Promise<Set<string>> {
  return new Promise<Set<string>>((resolve) => {
    const child = spawn("docker", [
      "exec",
      `sb-${ref}-db-1`,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-t",
      "-A",
      "-c",
      "select version from supabase_migrations.schema_migrations",
    ]);
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve(new Set()));
    child.on("close", () => resolve(new Set(out.split("\n").map((s) => s.trim()).filter(Boolean))));
  });
}

export interface DeployResult {
  repo: string;
  branch: string;
  applied: string[];
  skipped: string[];
}

/** Apply a project's connected repo migrations to its database (idempotent). */
export async function deployProject(ref: string): Promise<DeployResult> {
  const [proj] = await db.select().from(project).where(eq(project.ref, ref));
  if (!proj) throw new AppError(404, "project_not_found", "Project not found");
  if (proj.infrastructureType !== "shared") {
    throw new AppError(400, "deploy_unsupported_infra", "GitHub deploy is only supported on shared infrastructure");
  }
  const [conn] = await db
    .select()
    .from(projectRepoConnection)
    .where(eq(projectRepoConnection.projectId, proj.id));
  if (!conn) throw new AppError(400, "no_repo_connection", "No GitHub repository is connected to this project");

  const token = await githubToken(proj.organizationId);
  const branch = conn.branch ?? "main";
  const migrations = await fetchMigrations(conn.repoFullName, branch, token);

  // Ensure the migrations bookkeeping table exists.
  await psql(
    ref,
    `create schema if not exists supabase_migrations;
     create table if not exists supabase_migrations.schema_migrations (version text primary key, name text, statements text[], inserted_at timestamptz default now());`
  );
  const applied = await appliedVersions(ref);

  const didApply: string[] = [];
  const skipped: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.version)) {
      skipped.push(m.name);
      continue;
    }
    // Apply the migration and record it in the same transaction.
    const stmt = `begin;\n${m.sql}\n;\ninsert into supabase_migrations.schema_migrations(version, name) values (${quote(m.version)}, ${quote(m.name)}) on conflict (version) do nothing;\ncommit;`;
    await psql(ref, stmt);
    didApply.push(m.name);
  }
  return { repo: conn.repoFullName, branch, applied: didApply, skipped };
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
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
