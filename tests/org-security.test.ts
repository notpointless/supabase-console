import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { app } from "../src/app";
import { db } from "../src/db/client";
import { user } from "../src/db/schema";
import { setQueue, resetQueue, InlineQueue } from "../src/jobs/queue";
import { setProvisioner, resetProvisioner, StubProvisioner } from "../src/projects/provisioner";
import { setMailer, resetMailer } from "../src/email/mailer";

const json = (b: unknown, c = "") => { const h: Record<string,string> = { "content-type": "application/json" }; if (c) h.cookie = c; return { method: "POST", headers: h, body: JSON.stringify(b) } as RequestInit; };
const owner = async () => (await app.request("/api/auth/install/setup", json({ name: "Admin", email: "admin@example.com", password: "supersecret123" }))).headers.get("set-cookie") ?? "";
const org = async (c: string) => (await (await app.request("/api/auth/organization/create", json({ name: "Acme", type: "company" }, c))).json()).id;
async function addDeveloper(oc: string, orgId: string, email: string) {
  let inv = ""; setMailer({ sendInvite: async (e) => { inv = new URL(e.acceptUrl).searchParams.get("invitationId") ?? ""; } });
  await app.request("/api/auth/organization/invite-member", json({ email, role: "developer", organizationId: orgId }, oc));
  return (await app.request("/api/auth/invite/accept-new", json({ invitationId: inv, name: "Dev", password: "supersecret123" }))).headers.get("set-cookie") ?? "";
}

describe("org security / mfa", () => {
  beforeEach(() => { resetQueue(); setQueue(new InlineQueue()); resetProvisioner(); setProvisioner(new StubProvisioner()); resetMailer(); });

  it("owner sets mfaRequired and sees member compliance (no secrets)", async () => {
    const cookie = await owner(); const orgId = await org(cookie);
    const put = await app.request(`/api/v1/organizations/${orgId}/security`, { method: "PUT", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ mfaRequired: true }) });
    expect(put.status).toBe(200);
    const sec = await (await app.request(`/api/v1/organizations/${orgId}/security`, { headers: { cookie } })).json();
    expect(sec.mfaRequired).toBe(true);
    expect(sec.members[0]).toMatchObject({ email: "admin@example.com", mfaEnabled: false });
    expect(JSON.stringify(sec)).not.toMatch(/secret|backup/i);
  });

  it("developer cannot read or set security (403)", async () => {
    const cookie = await owner(); const orgId = await org(cookie); const dev = await addDeveloper(cookie, orgId, "dev@example.com");
    expect((await app.request(`/api/v1/organizations/${orgId}/security`, { headers: { cookie: dev } })).status).toBe(403);
    expect((await app.request(`/api/v1/organizations/${orgId}/security`, { method: "PUT", headers: { "content-type": "application/json", cookie: dev }, body: JSON.stringify({ mfaRequired: true }) })).status).toBe(403);
  });

  it("enforces MFA on project create when required", async () => {
    const cookie = await owner(); const orgId = await org(cookie);
    await app.request(`/api/v1/organizations/${orgId}/security`, { method: "PUT", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ mfaRequired: true }) });
    // owner has no 2FA → blocked
    const blocked = await app.request(`/api/v1/organizations/${orgId}/projects`, json({ name: "P", region: "shared", dbPassword: "supersecret123" }, cookie));
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error.code).toBe("mfa_required");
    // simulate enrollment: flip the admin user's twoFactorEnabled
    await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.email, "admin@example.com"));
    const ok = await app.request(`/api/v1/organizations/${orgId}/projects`, json({ name: "P", region: "shared", dbPassword: "supersecret123" }, cookie));
    expect(ok.status).toBe(200);
  });

  it("does not enforce when mfaRequired is false (default)", async () => {
    const cookie = await owner(); const orgId = await org(cookie);
    const res = await app.request(`/api/v1/organizations/${orgId}/projects`, json({ name: "P", region: "shared", dbPassword: "supersecret123" }, cookie));
    expect(res.status).toBe(200);
  });
});
