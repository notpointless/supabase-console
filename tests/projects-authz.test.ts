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

async function installOwner(email = "admin@example.com"): Promise<string> {
  const r = await app.request("/api/auth/install/setup", json({ name: "Admin", email, password: "supersecret123" }));
  return r.headers.get("set-cookie") ?? "";
}
async function createOrg(cookie: string, name = "Acme"): Promise<string> {
  return (await (await app.request("/api/auth/organization/create", json({ name, type: "company" }, cookie))).json()).id;
}
// Onboard a developer into orgId; returns their session cookie.
async function addDeveloper(ownerCookie: string, orgId: string, email: string): Promise<string> {
  let invitationId = "";
  setMailer({ sendInvite: async (e) => { invitationId = new URL(e.acceptUrl).searchParams.get("invitationId") ?? ""; } });
  await app.request("/api/auth/organization/invite-member", json({ email, role: "developer", organizationId: orgId }, ownerCookie));
  const res = await app.request("/api/auth/invite/accept-new", json({ invitationId, name: "Dev", password: "supersecret123" }));
  return res.headers.get("set-cookie") ?? "";
}

describe("project authz", () => {
  beforeEach(() => { resetQueue(); resetProvisioner(); setQueue(new InlineQueue()); resetMailer(); resetValidator(); setProvisioner(new StubProvisioner()); });

  it("a developer cannot create a project (403)", async () => {
    const ownerCookie = await installOwner();
    const orgId = await createOrg(ownerCookie);
    const devCookie = await addDeveloper(ownerCookie, orgId, "dev@example.com");
    const create = await app.request(`/api/v1/organizations/${orgId}/projects`, json({ name: "P", region: "shared", dbPassword: "supersecret123" }, devCookie));
    expect(create.status).toBe(403);
  });

  it("a developer cannot delete a project (403) but the owner can", async () => {
    const ownerCookie = await installOwner();
    const orgId = await createOrg(ownerCookie);
    const devCookie = await addDeveloper(ownerCookie, orgId, "dev@example.com");
    const ref = (await (await app.request(`/api/v1/organizations/${orgId}/projects`, json({ name: "P", region: "shared", dbPassword: "supersecret123" }, ownerCookie))).json()).ref;
    const devDel = await app.request(`/api/v1/projects/${ref}`, { method: "DELETE", headers: { cookie: devCookie } });
    expect(devDel.status).toBe(403);
    const ownerDel = await app.request(`/api/v1/projects/${ref}`, { method: "DELETE", headers: { cookie: ownerCookie } });
    expect(ownerDel.status).toBe(200);
  });

  it("a member of another org cannot access a project by ref (403)", async () => {
    const ownerCookie = await installOwner();
    const orgA = await createOrg(ownerCookie, "OrgA");
    const refA = (await (await app.request(`/api/v1/organizations/${orgA}/projects`, json({ name: "A", region: "shared", dbPassword: "supersecret123" }, ownerCookie))).json()).ref;
    // The same owner makes a second org (they are NOT auto a member-with-rights of project A from org B context);
    // create a separate user who only belongs to org B.
    const orgB = await createOrg(ownerCookie, "OrgB");
    const outsiderCookie = await addDeveloper(ownerCookie, orgB, "outsider@example.com");
    const get = await app.request(`/api/v1/projects/${refA}`, { headers: { cookie: outsiderCookie } });
    expect(get.status).toBe(403);
  });

  it("region rejections carry the right error codes", async () => {
    const ownerCookie = await installOwner();
    const orgId = await createOrg(ownerCookie);
    const unknown = await app.request(`/api/v1/organizations/${orgId}/projects`, json({ name: "P", region: "mars-1", dbPassword: "supersecret123" }, ownerCookie));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error.code).toBe("invalid_region");
    const ec2 = await app.request(`/api/v1/organizations/${orgId}/projects`, json({ name: "P", region: "us-west-2", dbPassword: "supersecret123" }, ownerCookie));
    expect(ec2.status).toBe(400);
    expect((await ec2.json()).error.code).toBe("ec2_unavailable");
  });
});
