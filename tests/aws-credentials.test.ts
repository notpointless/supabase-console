import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/app";
import { setValidator, resetValidator } from "../src/aws/credential-validator";
import { setMailer, resetMailer } from "../src/email/mailer";

const json = (body: unknown, cookie = ""): RequestInit => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers["cookie"] = cookie;
  return { method: "POST", headers, body: JSON.stringify(body) };
};
const req = (path: string, init?: RequestInit) => app.request(path, init);

async function installOwner(): Promise<string> {
  const res = await app.request("/api/auth/install/setup", json({ name: "Admin", email: "admin@example.com", password: "supersecret123" }));
  return res.headers.get("set-cookie") ?? "";
}
async function createOrg(cookie: string): Promise<string> {
  const res = await app.request("/api/auth/organization/create", json({ name: "Acme", type: "company" }, cookie));
  return (await res.json()).id;
}

describe("aws-credentials", () => {
  beforeEach(() => {
    resetValidator();
    resetMailer();
  });

  it("stores validated creds, enables EC2 regions, never returns the secret", async () => {
    setValidator({ validate: async () => ({ ok: true, accountId: "123456789012" }) });
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);

    const before = await (await req(`/api/v1/organizations/${orgId}/regions`, { headers: { cookie } })).json();
    expect(before.regions).toHaveLength(1);

    const add = await req(`/api/v1/organizations/${orgId}/aws-credentials`, json({ accessKeyId: "AKIA", secretAccessKey: "secret", defaultRegion: "us-west-2" }, cookie));
    expect(add.status).toBe(200);
    const addBody = await add.json();
    expect(addBody.validated).toBe(true);
    expect(addBody.accountId).toBe("123456789012");
    expect(JSON.stringify(addBody)).not.toContain("secret");

    const after = await (await req(`/api/v1/organizations/${orgId}/regions`, { headers: { cookie } })).json();
    expect(after.regions.length).toBeGreaterThan(1);

    const status = await (await req(`/api/v1/organizations/${orgId}/aws-credentials`, { headers: { cookie } })).json();
    expect(status).toMatchObject({ exists: true, validated: true, accountId: "123456789012", defaultRegion: "us-west-2" });
    expect(JSON.stringify(status)).not.toContain("secret");
  });

  it("rejects invalid creds (STS failure)", async () => {
    setValidator({ validate: async () => ({ ok: false, error: "bad key" }) });
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);
    const add = await req(`/api/v1/organizations/${orgId}/aws-credentials`, json({ accessKeyId: "AKIA", secretAccessKey: "secret", defaultRegion: "us-west-2" }, cookie));
    expect(add.status).toBe(400);
    const status = await (await req(`/api/v1/organizations/${orgId}/aws-credentials`, { headers: { cookie } })).json();
    expect(status.exists).toBe(false);
  });

  it("requires authentication", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);
    const res = await req(`/api/v1/organizations/${orgId}/aws-credentials`, { headers: {} });
    expect(res.status).toBe(401);
  });

  it("deletes creds", async () => {
    setValidator({ validate: async () => ({ ok: true, accountId: "1" }) });
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);
    await req(`/api/v1/organizations/${orgId}/aws-credentials`, json({ accessKeyId: "AKIA", secretAccessKey: "secret", defaultRegion: "us-west-2" }, cookie));
    const del = await req(`/api/v1/organizations/${orgId}/aws-credentials`, { method: "DELETE", headers: { cookie } });
    expect(del.status).toBe(200);
    const status = await (await req(`/api/v1/organizations/${orgId}/aws-credentials`, { headers: { cookie } })).json();
    expect(status.exists).toBe(false);
  });

  it("developer member cannot manage AWS creds (403)", async () => {
    let invitationId = "";
    setMailer({
      sendInvite: async (e) => {
        invitationId = new URL(e.acceptUrl).searchParams.get("invitationId") ?? "";
      },
    });

    const cookie = await installOwner();
    const orgId = await createOrg(cookie);

    // Invite dev@example.com as developer
    await app.request(
      "/api/auth/organization/invite-member",
      json({ email: "dev@example.com", role: "developer", organizationId: orgId }, cookie),
    );
    expect(invitationId).toBeTruthy();

    // Accept invite as a brand-new user
    const acceptRes = await app.request(
      "/api/auth/invite/accept-new",
      json({ invitationId, name: "Dev User", password: "supersecret123" }),
    );
    expect(acceptRes.status).toBe(200);
    const devCookie = acceptRes.headers.get("set-cookie") ?? "";

    // Developer must not be able to manage AWS creds
    const res = await req(
      `/api/v1/organizations/${orgId}/aws-credentials`,
      json({ accessKeyId: "AKIA", secretAccessKey: "secret", defaultRegion: "us-east-1" }, devCookie),
    );
    expect(res.status).toBe(403);
  });
});
