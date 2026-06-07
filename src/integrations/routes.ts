import { Hono } from "hono";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import {
  project,
  orgGithubConnection,
  orgVercelConnection,
  projectRepoConnection,
  projectPrivatelinkAccount,
} from "../db/schema";
import { requireSession, requirePermission } from "../http/guards";
import { AppError } from "../http/error";
import { encrypt } from "../crypto/secrets";
import { getProjectByRef } from "../projects/service";
import { getQueue } from "../jobs/queue";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  deployProject,
  getRepoConnection,
  setRepoConnection,
  deleteRepoConnection,
} from "./github-deploy";
import { syncPullRequestBranch } from "../projects/branches";

export const integrations = new Hono();

const MEMBER: Record<string, string[]> = { project: ["content"] };
const OWNER_ADMIN: Record<string, string[]> = { member: ["create"] };
const PROJECT_UPDATE: Record<string, string[]> = { project: ["update"] };

// ---------------------------------------------------------------------------
// GET /api/v1/organizations/:orgId/integrations
// Returns { github: { connected, githubLogin? }, vercel: { connected, vercelTeam? } }
// Never returns access tokens.
// ---------------------------------------------------------------------------
integrations.get("/api/v1/organizations/:orgId/integrations", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, MEMBER);

  const [github] = await db
    .select({ githubLogin: orgGithubConnection.githubLogin })
    .from(orgGithubConnection)
    .where(eq(orgGithubConnection.organizationId, orgId));

  const [vercel] = await db
    .select({ vercelTeam: orgVercelConnection.vercelTeam })
    .from(orgVercelConnection)
    .where(eq(orgVercelConnection.organizationId, orgId));

  return c.json({
    github: github
      ? { connected: true, githubLogin: github.githubLogin }
      : { connected: false },
    vercel: vercel
      ? { connected: true, vercelTeam: vercel.vercelTeam }
      : { connected: false },
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/organizations/:orgId/integrations/github
// Body: { githubLogin, accessToken, installationId? }
// Upserts the connection (one per org). Token stored encrypted.
// ---------------------------------------------------------------------------
const githubConnectSchema = z.object({
  githubLogin: z.string().min(1),
  accessToken: z.string().min(1),
  installationId: z.string().optional(),
});

integrations.post("/api/v1/organizations/:orgId/integrations/github", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, OWNER_ADMIN);

  const parsed = githubConnectSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new AppError(400, "validation_error", "Invalid GitHub connection payload", parsed.error.flatten());
  }

  const { githubLogin, accessToken, installationId } = parsed.data;
  const accessTokenEncrypted = encrypt(accessToken);

  await db
    .insert(orgGithubConnection)
    .values({
      organizationId: orgId,
      githubLogin,
      accessTokenEncrypted,
      installationId: installationId ?? null,
    })
    .onConflictDoUpdate({
      target: orgGithubConnection.organizationId,
      set: {
        githubLogin,
        accessTokenEncrypted,
        installationId: installationId ?? null,
      },
    });

  return c.json({ connected: true, githubLogin });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/organizations/:orgId/integrations/github
// ---------------------------------------------------------------------------
integrations.delete("/api/v1/organizations/:orgId/integrations/github", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, OWNER_ADMIN);

  await db
    .delete(orgGithubConnection)
    .where(eq(orgGithubConnection.organizationId, orgId));

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/v1/organizations/:orgId/integrations/vercel
// Body: { vercelTeam, accessToken }
// Upserts the connection. Token stored encrypted.
// ---------------------------------------------------------------------------
const vercelConnectSchema = z.object({
  vercelTeam: z.string().min(1),
  accessToken: z.string().min(1),
});

integrations.post("/api/v1/organizations/:orgId/integrations/vercel", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, OWNER_ADMIN);

  const parsed = vercelConnectSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new AppError(400, "validation_error", "Invalid Vercel connection payload", parsed.error.flatten());
  }

  const { vercelTeam, accessToken } = parsed.data;
  const accessTokenEncrypted = encrypt(accessToken);

  await db
    .insert(orgVercelConnection)
    .values({ organizationId: orgId, vercelTeam, accessTokenEncrypted })
    .onConflictDoUpdate({
      target: orgVercelConnection.organizationId,
      set: { vercelTeam, accessTokenEncrypted },
    });

  return c.json({ connected: true, vercelTeam });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/organizations/:orgId/integrations/vercel
// ---------------------------------------------------------------------------
integrations.delete("/api/v1/organizations/:orgId/integrations/vercel", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, OWNER_ADMIN);

  await db
    .delete(orgVercelConnection)
    .where(eq(orgVercelConnection.organizationId, orgId));

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/v1/projects/:ref/connections
// List repo links for the project (member permission on the owning org).
// ---------------------------------------------------------------------------
integrations.get("/api/v1/projects/:ref/connections", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const project = await getProjectByRef(ref);
  if (!project) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, project.organizationId, MEMBER);

  const rows = await db
    .select({
      id: projectRepoConnection.id,
      repoFullName: projectRepoConnection.repoFullName,
      branch: projectRepoConnection.branch,
      createdAt: projectRepoConnection.createdAt,
    })
    .from(projectRepoConnection)
    .where(eq(projectRepoConnection.projectId, project.id));

  return c.json({ connections: rows });
});

// ---------------------------------------------------------------------------
// POST /api/v1/projects/:ref/connections
// Body: { repoFullName, branch? }
// Requires GitHub connection on the org. Permission: project:update.
// ---------------------------------------------------------------------------
const repoLinkSchema = z.object({
  repoFullName: z.string().min(1),
  branch: z.string().optional(),
});

integrations.post("/api/v1/projects/:ref/connections", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const project = await getProjectByRef(ref);
  if (!project) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, project.organizationId, PROJECT_UPDATE);

  // Require a GitHub connection on the owning org
  const [github] = await db
    .select({ id: orgGithubConnection.id })
    .from(orgGithubConnection)
    .where(eq(orgGithubConnection.organizationId, project.organizationId));
  if (!github) {
    throw new AppError(400, "github_not_connected", "GitHub is not connected to this organization");
  }

  const parsed = repoLinkSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new AppError(400, "validation_error", "Invalid repo connection payload", parsed.error.flatten());
  }

  const { repoFullName, branch } = parsed.data;

  const [inserted] = await db
    .insert(projectRepoConnection)
    .values({ projectId: project.id, repoFullName, branch: branch ?? null })
    .returning();

  return c.json({
    id: inserted!.id,
    repoFullName: inserted!.repoFullName,
    branch: inserted!.branch,
    createdAt: inserted!.createdAt,
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/projects/:ref/connections/:id
// ---------------------------------------------------------------------------
integrations.delete("/api/v1/projects/:ref/connections/:id", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const id = c.req.param("id");
  const project = await getProjectByRef(ref);
  if (!project) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, project.organizationId, PROJECT_UPDATE);

  const [link] = await db
    .select({ id: projectRepoConnection.id })
    .from(projectRepoConnection)
    .where(
      and(
        eq(projectRepoConnection.id, id),
        eq(projectRepoConnection.projectId, project.id),
      ),
    );
  if (!link) throw new AppError(404, "not_found", "Repo connection not found");

  await db
    .delete(projectRepoConnection)
    .where(eq(projectRepoConnection.id, id));

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// AWS PrivateLink — allowed AWS account IDs (per project)
//
// NOTE: Actual VPC endpoint-service provisioning is DEFERRED.
//       These routes manage the account allowlist only.
//       status is always "pending" until provisioning is implemented.
// ---------------------------------------------------------------------------

const awsAccountIdSchema = z.object({
  awsAccountId: z.string().regex(/^\d{12}$/, "AWS account ID must be exactly 12 digits"),
});

// GET /api/v1/projects/:ref/privatelink/accounts
// Member permission (project:content). Returns { accounts: [{ id, awsAccountId, status }] }.
integrations.get("/api/v1/projects/:ref/privatelink/accounts", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const project = await getProjectByRef(ref);
  if (!project) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, project.organizationId, MEMBER);

  const rows = await db
    .select({
      id: projectPrivatelinkAccount.id,
      awsAccountId: projectPrivatelinkAccount.awsAccountId,
      status: projectPrivatelinkAccount.status,
    })
    .from(projectPrivatelinkAccount)
    .where(eq(projectPrivatelinkAccount.projectId, project.id));

  return c.json({ accounts: rows });
});

// POST /api/v1/projects/:ref/privatelink/accounts
// Owner/admin permission (member:create). Body: { awsAccountId }.
// Inserts with status "pending". Rejects duplicate with 409 account_exists.
integrations.post("/api/v1/projects/:ref/privatelink/accounts", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const project = await getProjectByRef(ref);
  if (!project) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, project.organizationId, OWNER_ADMIN);

  const parsed = awsAccountIdSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new AppError(400, "validation_error", "Invalid payload", parsed.error.flatten());
  }

  const { awsAccountId } = parsed.data;

  // Check for duplicate before insert for a clear 409 error code.
  const [existing] = await db
    .select({ id: projectPrivatelinkAccount.id })
    .from(projectPrivatelinkAccount)
    .where(
      and(
        eq(projectPrivatelinkAccount.projectId, project.id),
        eq(projectPrivatelinkAccount.awsAccountId, awsAccountId),
      ),
    );
  if (existing) {
    throw new AppError(409, "account_exists", "This AWS account ID is already in the allowlist");
  }

  const [inserted] = await db
    .insert(projectPrivatelinkAccount)
    .values({ projectId: project.id, awsAccountId })
    .returning();

  return c.json({
    id: inserted!.id,
    awsAccountId: inserted!.awsAccountId,
    status: inserted!.status,
  });
});

// DELETE /api/v1/projects/:ref/privatelink/accounts/:id
// Owner/admin permission (member:create).
integrations.delete("/api/v1/projects/:ref/privatelink/accounts/:id", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const id = c.req.param("id");
  const project = await getProjectByRef(ref);
  if (!project) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, project.organizationId, OWNER_ADMIN);

  const [row] = await db
    .select({ id: projectPrivatelinkAccount.id })
    .from(projectPrivatelinkAccount)
    .where(
      and(
        eq(projectPrivatelinkAccount.id, id),
        eq(projectPrivatelinkAccount.projectId, project.id),
      ),
    );
  if (!row) throw new AppError(404, "not_found", "PrivateLink account not found");

  await db
    .delete(projectPrivatelinkAccount)
    .where(eq(projectPrivatelinkAccount.id, id));

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GitHub deploy pipeline: connect a repo+branch to a project and apply its
// `supabase/migrations/*.sql` to the project DB (manually or via push webhook).
// ---------------------------------------------------------------------------
const repoConnSchema = z.object({
  repository: z.string().min(3), // owner/repo
  branch: z.string().min(1).default("main"),
});

integrations.get("/api/v1/projects/:ref/github/connection", async (c) => {
  await requireSession(c);
  const proj = await getProjectByRef(c.req.param("ref"));
  if (!proj) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, proj.organizationId, MEMBER);
  const conn = await getRepoConnection(proj.id);
  return c.json(conn ? { connected: true, repository: conn.repoFullName, branch: conn.branch } : { connected: false });
});

integrations.put("/api/v1/projects/:ref/github/connection", async (c) => {
  await requireSession(c);
  const proj = await getProjectByRef(c.req.param("ref"));
  if (!proj) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, proj.organizationId, PROJECT_UPDATE);
  const parsed = repoConnSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError(400, "validation_error", "Invalid connection payload", parsed.error.flatten());
  const conn = await setRepoConnection(proj, parsed.data.repository, parsed.data.branch);
  return c.json({ connected: true, repository: conn.repoFullName, branch: conn.branch });
});

integrations.delete("/api/v1/projects/:ref/github/connection", async (c) => {
  await requireSession(c);
  const proj = await getProjectByRef(c.req.param("ref"));
  if (!proj) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, proj.organizationId, PROJECT_UPDATE);
  await deleteRepoConnection(proj.id);
  return c.json({ connected: false });
});

// Apply the connected repo's migrations now.
integrations.post("/api/v1/projects/:ref/github/deploy", async (c) => {
  await requireSession(c);
  const ref = c.req.param("ref");
  const proj = await getProjectByRef(ref);
  if (!proj) throw new AppError(404, "project_not_found", "Project not found");
  await requirePermission(c, proj.organizationId, PROJECT_UPDATE);
  const result = await deployProject(ref);
  return c.json(result);
});

// GitHub push webhook. Verifies the HMAC signature against GITHUB_WEBHOOK_SECRET,
// then enqueues a deploy for every project connected to the pushed repo+branch.
// (Reachable only when the backend is exposed publicly; no-ops gracefully otherwise.)
integrations.post("/api/v1/github/webhook", async (c) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const raw = await c.req.text();
  if (secret) {
    const sig = c.req.header("x-hub-signature-256") ?? "";
    const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AppError(401, "invalid_signature", "Invalid webhook signature");
    }
  }
  const event = c.req.header("x-github-event");
  if (event !== "push" && event !== "pull_request") return c.json({ ok: true, ignored: true });
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new AppError(400, "invalid_payload", "Invalid JSON");
  }
  const repoFullName: string | undefined = payload?.repository?.full_name;

  // pull_request: open -> create a preview branch (+ its repo connection) on each
  // connected production project; close -> tear it down. The push event below then
  // deploys the PR's migrations to that branch.
  if (event === "pull_request") {
    const action: string = payload?.action ?? "";
    const headRef: string | undefined = payload?.pull_request?.head?.ref;
    if (!repoFullName || !headRef) return c.json({ ok: true, ignored: true });
    const synced = await syncPullRequestBranch(repoFullName, action, headRef);
    return c.json({ ok: true, synced });
  }

  const pushedBranch: string | undefined = (payload?.ref ?? "").replace("refs/heads/", "");
  if (!repoFullName || !pushedBranch) return c.json({ ok: true, ignored: true });

  const conns = await db
    .select({ projectId: projectRepoConnection.projectId, branch: projectRepoConnection.branch })
    .from(projectRepoConnection)
    .where(eq(projectRepoConnection.repoFullName, repoFullName));
  const targetIds = conns.filter((x) => (x.branch ?? "main") === pushedBranch).map((x) => x.projectId);

  let deploying = 0;
  for (const pid of targetIds) {
    const [proj] = await db.select().from(project).where(eq(project.id, pid));
    if (proj) {
      await getQueue().enqueue("github_deploy", { ref: proj.ref });
      deploying++;
    }
  }
  return c.json({ ok: true, deploying });
});
