import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/app";
import { setQueue, resetQueue, InlineQueue } from "../src/jobs/queue";
import { setMailer, resetMailer } from "../src/email/mailer";
import { resetValidator } from "../src/aws/credential-validator";
import { setProvisioner, resetProvisioner, StubProvisioner } from "../src/projects/provisioner";

const json = (body: unknown, cookie = "") => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return { method: "POST", headers, body: JSON.stringify(body) } as RequestInit;
};

async function installOwner(): Promise<string> {
  const r = await app.request("/api/auth/install/setup", json({ name: "Admin", email: "admin@example.com", password: "supersecret123" }));
  return r.headers.get("set-cookie") ?? "";
}

async function createOrg(cookie: string): Promise<string> {
  return (await (await app.request("/api/auth/organization/create", json({ name: "Acme", type: "company" }, cookie))).json()).id;
}

async function addDeveloper(ownerCookie: string, orgId: string, email: string): Promise<string> {
  let invitationId = "";
  setMailer({ sendInvite: async (e) => { invitationId = new URL(e.acceptUrl).searchParams.get("invitationId") ?? ""; } });
  await app.request("/api/auth/organization/invite-member", json({ email, role: "developer", organizationId: orgId }, ownerCookie));
  const res = await app.request("/api/auth/invite/accept-new", json({ invitationId, name: "Dev", password: "supersecret123" }));
  resetMailer();
  return res.headers.get("set-cookie") ?? "";
}

describe("audit logs", () => {
  beforeEach(() => {
    resetQueue();
    resetProvisioner();
    resetMailer();
    resetValidator();
    setQueue(new InlineQueue());
    setProvisioner(new StubProvisioner());
  });

  it("a POST mutation is recorded; GET account/audit-logs returns the row", async () => {
    const ownerCookie = await installOwner();
    // Creating an org is a mutation on /api/auth but NOT /api/v1 — it won't be recorded.
    // Use the /api/v1 surface: create a project (POST /api/v1/organizations/:orgId/projects).
    const orgId = await createOrg(ownerCookie);

    const createProject = await app.request(
      `/api/v1/organizations/${orgId}/projects`,
      json({ name: "TestProj", region: "shared", dbPassword: "supersecret123" }, ownerCookie),
    );
    expect(createProject.status).toBe(200);

    // Poll the account audit log.
    const res = await app.request("/api/v1/account/audit-logs", { headers: { cookie: ownerCookie } });
    expect(res.status).toBe(200);
    const body = await res.json() as { logs: Array<{ id: string; method: string; path: string; statusCode: number; organizationId: string | null; createdAt: string }> };
    expect(body.logs.length).toBeGreaterThan(0);
    const row = body.logs.find((l) => l.method === "POST" && l.path.includes("/projects"));
    expect(row).toBeDefined();
    expect(row!.statusCode).toBe(200);
    expect(row!.organizationId).toBe(orgId);
  });

  it("GET /api/v1/organizations/:orgId/audit-logs returns org-scoped rows (owner can access)", async () => {
    const ownerCookie = await installOwner();
    const orgId = await createOrg(ownerCookie);

    // Create a project under this org — POST mutation will be recorded with this orgId.
    await app.request(
      `/api/v1/organizations/${orgId}/projects`,
      json({ name: "Proj", region: "shared", dbPassword: "supersecret123" }, ownerCookie),
    );

    const res = await app.request(`/api/v1/organizations/${orgId}/audit-logs`, { headers: { cookie: ownerCookie } });
    expect(res.status).toBe(200);
    const body = await res.json() as { logs: Array<{ id: string; method: string; path: string; statusCode: number; organizationId: string | null }> };
    expect(body.logs.length).toBeGreaterThan(0);
    // All rows must belong to this org.
    for (const row of body.logs) {
      expect(row.organizationId).toBe(orgId);
    }
    // The project-create POST must appear.
    expect(body.logs.some((l) => l.method === "POST" && l.path.includes("/projects"))).toBe(true);
  });

  it("a developer cannot read org audit logs (403) but CAN read their own account audit logs", async () => {
    const ownerCookie = await installOwner();
    const orgId = await createOrg(ownerCookie);
    const devCookie = await addDeveloper(ownerCookie, orgId, "dev@example.com");

    // Developer should not see org-level audit logs.
    const orgLogsRes = await app.request(`/api/v1/organizations/${orgId}/audit-logs`, { headers: { cookie: devCookie } });
    expect(orgLogsRes.status).toBe(403);

    // Developer CAN see their own account audit logs.
    const accountLogsRes = await app.request("/api/v1/account/audit-logs", { headers: { cookie: devCookie } });
    expect(accountLogsRes.status).toBe(200);
  });

  it("unauthenticated request to audit-logs returns 401", async () => {
    const ownerCookie = await installOwner();
    const orgId = await createOrg(ownerCookie);

    const accountRes = await app.request("/api/v1/account/audit-logs");
    expect(accountRes.status).toBe(401);

    const orgRes = await app.request(`/api/v1/organizations/${orgId}/audit-logs`);
    expect(orgRes.status).toBe(401);
  });

  it("a failed (400) POST still records an audit row with the correct statusCode", async () => {
    const ownerCookie = await installOwner();
    const orgId = await createOrg(ownerCookie);

    // Deliberately invalid payload → 400.
    const badRes = await app.request(
      `/api/v1/organizations/${orgId}/projects`,
      json({ name: "P", region: "mars-does-not-exist", dbPassword: "supersecret123" }, ownerCookie),
    );
    expect(badRes.status).toBe(400);

    const logsRes = await app.request("/api/v1/account/audit-logs", { headers: { cookie: ownerCookie } });
    expect(logsRes.status).toBe(200);
    const { logs } = await logsRes.json() as { logs: Array<{ statusCode: number; method: string; path: string }> };
    const bad = logs.find((l) => l.statusCode === 400 && l.method === "POST" && l.path.includes("/projects"));
    expect(bad).toBeDefined();
  });

  it("GET requests are NOT recorded in the audit log", async () => {
    const ownerCookie = await installOwner();
    const orgId = await createOrg(ownerCookie);

    // Perform several GETs — none should be recorded.
    await app.request("/api/v1/me", { headers: { cookie: ownerCookie } });
    await app.request(`/api/v1/organizations/${orgId}/projects`, { headers: { cookie: ownerCookie } });
    await app.request("/api/v1/account/audit-logs", { headers: { cookie: ownerCookie } });

    const logsRes = await app.request("/api/v1/account/audit-logs", { headers: { cookie: ownerCookie } });
    const { logs } = await logsRes.json() as { logs: Array<{ method: string }> };
    // There should be no GET rows at all.
    const getRows = logs.filter((l) => l.method === "GET");
    expect(getRows).toHaveLength(0);
  });
});
