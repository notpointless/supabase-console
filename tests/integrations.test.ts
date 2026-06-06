import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/app";
import { setMailer, resetMailer } from "../src/email/mailer";
import { setQueue, resetQueue, InlineQueue } from "../src/jobs/queue";
import { setProvisioner, resetProvisioner, StubProvisioner } from "../src/projects/provisioner";
import { db } from "../src/db/client";
import { orgGithubConnection } from "../src/db/schema";
import { eq } from "drizzle-orm";

const json = (body: unknown, cookie = "") => {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (cookie) h.cookie = cookie;
  return { method: "POST", headers: h, body: JSON.stringify(body) } as RequestInit;
};

async function installOwner(): Promise<string> {
  const r = await app.request(
    "/api/auth/install/setup",
    json({ name: "Admin", email: "admin@example.com", password: "supersecret123" }),
  );
  return r.headers.get("set-cookie") ?? "";
}

async function createOrg(cookie: string, name = "Acme"): Promise<string> {
  const r = await app.request(
    "/api/auth/organization/create",
    json({ name, type: "company" }, cookie),
  );
  return ((await r.json()) as { id: string }).id;
}

async function addDeveloper(ownerCookie: string, orgId: string): Promise<string> {
  let inv = "";
  setMailer({
    sendInvite: async (e) => {
      inv = new URL(e.acceptUrl).searchParams.get("invitationId") ?? "";
    },
  });
  await app.request(
    "/api/auth/organization/invite-member",
    json({ email: "dev@example.com", role: "developer", organizationId: orgId }, ownerCookie),
  );
  const r = await app.request(
    "/api/auth/invite/accept-new",
    json({ invitationId: inv, name: "Dev User", password: "supersecret123" }),
  );
  resetMailer();
  return r.headers.get("set-cookie") ?? "";
}

async function createProject(ownerCookie: string, orgId: string): Promise<string> {
  const r = await app.request(
    `/api/v1/organizations/${orgId}/projects`,
    json({ name: "Test Project", region: "shared", dbPassword: "supersecret123" }, ownerCookie),
  );
  return ((await r.json()) as { ref: string }).ref;
}

describe("integrations", () => {
  beforeEach(() => {
    resetMailer();
    resetQueue();
    resetProvisioner();
    setQueue(new InlineQueue());
    setProvisioner(new StubProvisioner());
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/organizations/:orgId/integrations
  // -------------------------------------------------------------------------

  it("returns empty integration status when nothing connected", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);

    const res = await app.request(`/api/v1/organizations/${orgId}/integrations`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      github: { connected: boolean; githubLogin?: string };
      vercel: { connected: boolean; vercelTeam?: string };
    };
    expect(body.github.connected).toBe(false);
    expect(body.github.githubLogin).toBeUndefined();
    expect(body.vercel.connected).toBe(false);
    expect(body.vercel.vercelTeam).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // GitHub: connect → status shows connected; token never returned
  // -------------------------------------------------------------------------

  it("connects GitHub: token stored encrypted, status shows connected+login, token never in any response", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);

    const res = await app.request(
      `/api/v1/organizations/${orgId}/integrations/github`,
      json({ githubLogin: "acme-org", accessToken: "ghp_supersecret" }, cookie),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connected: boolean; githubLogin: string };
    expect(body.connected).toBe(true);
    expect(body.githubLogin).toBe("acme-org");
    // Token must NOT appear in the response
    const responseText = JSON.stringify(body);
    expect(responseText).not.toContain("ghp_supersecret");
    expect(responseText).not.toContain("accessToken");
    expect(responseText).not.toContain("access_token");

    // Verify the raw DB row stores an encrypted value, NOT the plaintext
    const [row] = await db
      .select()
      .from(orgGithubConnection)
      .where(eq(orgGithubConnection.organizationId, orgId));
    expect(row).toBeDefined();
    expect(row!.accessTokenEncrypted).not.toBe("ghp_supersecret");
    // Encrypted value should look like base64:base64:base64
    expect(row!.accessTokenEncrypted).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);

    // GET status also never returns the token
    const statusRes = await app.request(`/api/v1/organizations/${orgId}/integrations`, {
      headers: { cookie },
    });
    expect(statusRes.status).toBe(200);
    const statusText = await statusRes.text();
    expect(statusText).not.toContain("ghp_supersecret");
    expect(statusText).not.toContain("accessToken");
    const status = JSON.parse(statusText) as {
      github: { connected: boolean; githubLogin: string };
      vercel: { connected: boolean };
    };
    expect(status.github.connected).toBe(true);
    expect(status.github.githubLogin).toBe("acme-org");
  });

  it("connects GitHub with installationId", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);

    const res = await app.request(
      `/api/v1/organizations/${orgId}/integrations/github`,
      json({ githubLogin: "acme-org", accessToken: "ghp_abc", installationId: "inst_123" }, cookie),
    );
    expect(res.status).toBe(200);
    const [row] = await db
      .select()
      .from(orgGithubConnection)
      .where(eq(orgGithubConnection.organizationId, orgId));
    expect(row!.installationId).toBe("inst_123");
  });

  it("upserting GitHub connection replaces the previous one", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);

    await app.request(
      `/api/v1/organizations/${orgId}/integrations/github`,
      json({ githubLogin: "old-login", accessToken: "ghp_old" }, cookie),
    );
    const res = await app.request(
      `/api/v1/organizations/${orgId}/integrations/github`,
      json({ githubLogin: "new-login", accessToken: "ghp_new" }, cookie),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { githubLogin: string };
    expect(body.githubLogin).toBe("new-login");

    const rows = await db
      .select()
      .from(orgGithubConnection)
      .where(eq(orgGithubConnection.organizationId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.githubLogin).toBe("new-login");
  });

  // -------------------------------------------------------------------------
  // Vercel: connect → status shows connected; token never returned
  // -------------------------------------------------------------------------

  it("connects Vercel: status shows connected+team, token never in any response", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);

    const res = await app.request(
      `/api/v1/organizations/${orgId}/integrations/vercel`,
      json({ vercelTeam: "my-vercel-team", accessToken: "vercel_supersecret" }, cookie),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connected: boolean; vercelTeam: string };
    expect(body.connected).toBe(true);
    expect(body.vercelTeam).toBe("my-vercel-team");
    expect(JSON.stringify(body)).not.toContain("vercel_supersecret");
    expect(JSON.stringify(body)).not.toContain("accessToken");

    const statusRes = await app.request(`/api/v1/organizations/${orgId}/integrations`, {
      headers: { cookie },
    });
    const statusText = await statusRes.text();
    expect(statusText).not.toContain("vercel_supersecret");
    const status = JSON.parse(statusText) as {
      github: { connected: boolean };
      vercel: { connected: boolean; vercelTeam: string };
    };
    expect(status.vercel.connected).toBe(true);
    expect(status.vercel.vercelTeam).toBe("my-vercel-team");
  });

  // -------------------------------------------------------------------------
  // Disconnect GitHub and Vercel
  // -------------------------------------------------------------------------

  it("disconnects GitHub and status reflects that", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);

    await app.request(
      `/api/v1/organizations/${orgId}/integrations/github`,
      json({ githubLogin: "acme", accessToken: "ghp_x" }, cookie),
    );
    const del = await app.request(`/api/v1/organizations/${orgId}/integrations/github`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(del.status).toBe(200);

    const status = (await (
      await app.request(`/api/v1/organizations/${orgId}/integrations`, { headers: { cookie } })
    ).json()) as { github: { connected: boolean } };
    expect(status.github.connected).toBe(false);
  });

  it("disconnects Vercel and status reflects that", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);

    await app.request(
      `/api/v1/organizations/${orgId}/integrations/vercel`,
      json({ vercelTeam: "team", accessToken: "vt_x" }, cookie),
    );
    const del = await app.request(`/api/v1/organizations/${orgId}/integrations/vercel`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(del.status).toBe(200);

    const status = (await (
      await app.request(`/api/v1/organizations/${orgId}/integrations`, { headers: { cookie } })
    ).json()) as { vercel: { connected: boolean } };
    expect(status.vercel.connected).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Authorization: developer cannot connect/disconnect (403)
  // -------------------------------------------------------------------------

  it("developer cannot connect GitHub (403)", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);
    const devCookie = await addDeveloper(cookie, orgId);

    const res = await app.request(
      `/api/v1/organizations/${orgId}/integrations/github`,
      json({ githubLogin: "acme", accessToken: "ghp_x" }, devCookie),
    );
    expect(res.status).toBe(403);
  });

  it("developer cannot disconnect GitHub (403)", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);

    await app.request(
      `/api/v1/organizations/${orgId}/integrations/github`,
      json({ githubLogin: "acme", accessToken: "ghp_x" }, cookie),
    );

    const devCookie = await addDeveloper(cookie, orgId);
    const res = await app.request(`/api/v1/organizations/${orgId}/integrations/github`, {
      method: "DELETE",
      headers: { cookie: devCookie },
    });
    expect(res.status).toBe(403);
  });

  it("developer cannot connect Vercel (403)", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);
    const devCookie = await addDeveloper(cookie, orgId);

    const res = await app.request(
      `/api/v1/organizations/${orgId}/integrations/vercel`,
      json({ vercelTeam: "team", accessToken: "vt_x" }, devCookie),
    );
    expect(res.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Project repo connections
  // -------------------------------------------------------------------------

  it("links a repo to a project after GitHub is connected", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);

    await app.request(
      `/api/v1/organizations/${orgId}/integrations/github`,
      json({ githubLogin: "acme", accessToken: "ghp_x" }, cookie),
    );

    const ref = await createProject(cookie, orgId);

    const linkRes = await app.request(
      `/api/v1/projects/${ref}/connections`,
      json({ repoFullName: "acme/my-app", branch: "main" }, cookie),
    );
    expect(linkRes.status).toBe(200);
    const link = (await linkRes.json()) as { id: string; repoFullName: string; branch: string };
    expect(link.repoFullName).toBe("acme/my-app");
    expect(link.branch).toBe("main");
    expect(link.id).toBeTruthy();

    const listRes = await app.request(`/api/v1/projects/${ref}/connections`, {
      headers: { cookie },
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { connections: Array<{ repoFullName: string; branch: string }> };
    expect(list.connections).toHaveLength(1);
    expect(list.connections[0]!.repoFullName).toBe("acme/my-app");
    expect(list.connections[0]!.branch).toBe("main");
  });

  it("linking a repo without GitHub connection → 400 github_not_connected", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);
    const ref = await createProject(cookie, orgId);

    const res = await app.request(
      `/api/v1/projects/${ref}/connections`,
      json({ repoFullName: "acme/my-app" }, cookie),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("github_not_connected");
  });

  it("deletes a repo link", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);

    await app.request(
      `/api/v1/organizations/${orgId}/integrations/github`,
      json({ githubLogin: "acme", accessToken: "ghp_x" }, cookie),
    );

    const ref = await createProject(cookie, orgId);
    const linkRes = await app.request(
      `/api/v1/projects/${ref}/connections`,
      json({ repoFullName: "acme/my-app" }, cookie),
    );
    const { id } = (await linkRes.json()) as { id: string };

    const del = await app.request(`/api/v1/projects/${ref}/connections/${id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(del.status).toBe(200);

    const listRes = await app.request(`/api/v1/projects/${ref}/connections`, {
      headers: { cookie },
    });
    const list = (await listRes.json()) as { connections: unknown[] };
    expect(list.connections).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Unauthenticated → 401
  // -------------------------------------------------------------------------

  it("unauthenticated requests return 401", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);

    const r1 = await app.request(`/api/v1/organizations/${orgId}/integrations`);
    expect(r1.status).toBe(401);

    const r2 = await app.request(
      `/api/v1/organizations/${orgId}/integrations/github`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ githubLogin: "x", accessToken: "y" }) },
    );
    expect(r2.status).toBe(401);
  });
});
