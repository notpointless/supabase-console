import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/app";
import { setQueue, resetQueue, InlineQueue } from "../src/jobs/queue";
import { setMailer, resetMailer } from "../src/email/mailer";
import { setProvisioner, resetProvisioner, StubProvisioner } from "../src/projects/provisioner";

const json = (body: unknown, cookie = "") => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return { method: "POST", headers, body: JSON.stringify(body) } as RequestInit;
};
const owner = async () => (await app.request("/api/auth/install/setup", json({ name: "Admin", email: "admin@example.com", password: "supersecret123" }))).headers.get("set-cookie") ?? "";
const org = async (cookie: string, name = "Acme") => (await (await app.request("/api/auth/organization/create", json({ name, type: "company" }, cookie))).json()).id;
const mkProject = async (cookie: string, orgId: string) => (await (await app.request(`/api/v1/organizations/${orgId}/projects`, json({ name: "P", region: "shared", dbPassword: "supersecret123" }, cookie))).json()).ref;
async function addDeveloper(ownerCookie: string, orgId: string, email: string): Promise<string> {
  let invitationId = "";
  setMailer({ sendInvite: async (e) => { invitationId = new URL(e.acceptUrl).searchParams.get("invitationId") ?? ""; } });
  await app.request("/api/auth/organization/invite-member", json({ email, role: "developer", organizationId: orgId }, ownerCookie));
  const res = await app.request("/api/auth/invite/accept-new", json({ invitationId, name: "Dev", password: "supersecret123" }));
  return res.headers.get("set-cookie") ?? "";
}

describe("project api-keys", () => {
  beforeEach(() => { resetQueue(); resetProvisioner(); setQueue(new InlineQueue()); resetMailer(); setProvisioner(new StubProvisioner()); });

  it("returns anon + service_role to a member, never the jwt secret", async () => {
    const cookie = await owner();
    const orgId = await org(cookie);
    const ref = await mkProject(cookie, orgId);
    const res = await app.request(`/api/v1/projects/${ref}/api-keys`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.anonKey.split(".")).toHaveLength(3);
    expect(body.serviceRoleKey.split(".")).toHaveLength(3);
    // Endpoint also exposes the new-format publishable/secret keys (sb_publishable_/sb_secret_).
    expect(Object.keys(body).sort()).toEqual([
      "anonKey",
      "publishableKey",
      "secretKey",
      "serviceRoleKey",
    ]);
    expect(body.publishableKey).toMatch(/^sb_publishable_/);
    expect(body.secretKey).toMatch(/^sb_secret_/);
  });

  it("404 for unknown project", async () => {
    const cookie = await owner();
    await org(cookie);
    const res = await app.request(`/api/v1/projects/doesnotexist/api-keys`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it("403 for a member of another org", async () => {
    const cookie = await owner();
    const orgA = await org(cookie, "A");
    const ref = await mkProject(cookie, orgA);
    const orgB = await org(cookie, "B");
    const outsider = await addDeveloper(cookie, orgB, "outsider@example.com");
    const res = await app.request(`/api/v1/projects/${ref}/api-keys`, { headers: { cookie: outsider } });
    expect(res.status).toBe(403);
  });

  it("401 unauthenticated", async () => {
    const cookie = await owner();
    const orgId = await org(cookie);
    const ref = await mkProject(cookie, orgId);
    const res = await app.request(`/api/v1/projects/${ref}/api-keys`);
    expect(res.status).toBe(401);
  });
});
