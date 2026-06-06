import { Hono } from "hono";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import {
  orgGithubConnection,
  orgVercelConnection,
  projectRepoConnection,
  projectPrivatelinkAccount,
} from "../db/schema";
import { requireSession, requirePermission } from "../http/guards";
import { AppError } from "../http/error";
import { encrypt } from "../crypto/secrets";
import { getProjectByRef } from "../projects/service";

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
