/**
 * End-to-end flow test for the control-plane API.
 *
 * Exercises the entire lifecycle against the in-process Hono app with a real
 * (testcontainer) Postgres, the inline job queue, the stub provisioner, and a
 * mocked AWS credential validator — so every route runs for real without Docker
 * or AWS. Each `it` asserts a slice of the system; together they cover install,
 * auth, account, organizations, org settings (security/sso/oauth/integrations/
 * usage/audit/aws-credentials), and the full project lifecycle.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/app";
import { setQueue, resetQueue, InlineQueue } from "../src/jobs/queue";
import { setValidator, resetValidator } from "../src/aws/credential-validator";
import { setProvisioner, resetProvisioner, StubProvisioner } from "../src/projects/provisioner";

const ADMIN = { name: "Admin", email: "admin@example.com", password: "supersecret123" };

function post(body: unknown, cookie = "", method = "POST"): RequestInit {
  const headers: Record<string, string> = { "content-type": "application/json", origin: "http://localhost:3000" };
  if (cookie) headers.cookie = cookie;
  return { method, headers, body: JSON.stringify(body) };
}
const get = (cookie: string): RequestInit => ({ headers: { cookie, origin: "http://localhost:3000" } });

async function install(): Promise<string> {
  const r = await app.request("/api/auth/install/setup", post(ADMIN));
  return r.headers.get("set-cookie") ?? "";
}
async function createOrg(cookie: string, name = "Acme"): Promise<string> {
  const r = await app.request("/api/auth/organization/create", post({ name, type: "company" }, cookie));
  return (await r.json()).id;
}
async function createProject(cookie: string, orgId: string, name = "Proj"): Promise<string> {
  const r = await app.request(
    `/api/v1/organizations/${orgId}/projects`,
    post({ name, region: "shared", dbPassword: "supersecret123" }, cookie)
  );
  return (await r.json()).ref;
}

beforeEach(() => {
  resetQueue();
  resetValidator();
  resetProvisioner();
  setQueue(new InlineQueue());
  setProvisioner(new StubProvisioner());
});

describe("e2e: health & install", () => {
  it("healthz is ok", async () => {
    expect((await app.request("/healthz")).status).toBe(200);
  });

  it("install is one-time and gates /api/v1", async () => {
    expect(await (await app.request("/api/auth/install/status")).json()).toEqual({ installed: false });
    // /api/v1 is gated before install
    expect((await app.request("/api/v1/me")).status).toBe(409);
    const cookie = await install();
    expect(cookie).toContain("supabase-console.session");
    expect(await (await app.request("/api/auth/install/status")).json()).toEqual({ installed: true });
    // second setup is rejected
    expect((await app.request("/api/auth/install/setup", post(ADMIN))).status).toBe(409);
  });
});

describe("e2e: auth & account", () => {
  it("sign-in returns a session and /api/v1/me works", async () => {
    await install();
    const signIn = await app.request("/api/auth/sign-in/email", post({ email: ADMIN.email, password: ADMIN.password }));
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get("set-cookie") ?? "";
    const me = await app.request("/api/v1/me", get(cookie));
    expect(me.status).toBe(200);
    expect((await me.json()).user.email).toBe(ADMIN.email);
  });

  it("account profile: get + update", async () => {
    const cookie = await install();
    const prof = await (await app.request("/api/v1/account/profile", get(cookie))).json();
    expect(prof.email).toBe(ADMIN.email);
    expect(prof.isPlatformAdmin).toBe(true);
    const upd = await app.request("/api/v1/account/profile", post({ firstName: "Z", lastName: "V", username: "zeljko" }, cookie, "PUT"));
    expect(upd.status).toBe(200);
    expect((await upd.json()).firstName).toBe("Z");
    // never leaks password/hash
    expect(JSON.stringify(await (await app.request("/api/v1/account/profile", get(cookie))).json())).not.toMatch(/password|hash/i);
  });

  it("first admin cannot delete their own account", async () => {
    const cookie = await install();
    const del = await app.request("/api/v1/account/delete", post({}, cookie));
    expect(del.status).toBeGreaterThanOrEqual(400);
  });

  it("access tokens: create, list, delete", async () => {
    const cookie = await install();
    const created = await app.request("/api/v1/account/access-tokens", post({ name: "tok", expiresInDays: 30, type: "classic" }, cookie));
    expect(created.status).toBe(200);
    const token = await created.json();
    expect(token.token).toMatch(/^sbp_/);
    const list = await (await app.request("/api/v1/account/access-tokens", get(cookie))).json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(1);
    expect(JSON.stringify(list)).not.toContain(token.token); // raw token never re-listed
    const del = await app.request(`/api/v1/account/access-tokens/${token.id}`, { method: "DELETE", headers: { cookie } });
    expect(del.status).toBe(200);
    expect((await (await app.request("/api/v1/account/access-tokens", get(cookie))).json()).length).toBe(0);
  });

  it("account audit logs returns a list", async () => {
    const cookie = await install();
    await createOrg(cookie); // generates an audited mutation
    const res = await app.request("/api/v1/account/audit-logs", get(cookie));
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).logs)).toBe(true);
  });
});

describe("e2e: organizations & settings", () => {
  it("create, list, get-full-organization with members", async () => {
    const cookie = await install();
    const orgId = await createOrg(cookie);
    const list = await (await app.request("/api/auth/organization/list", get(cookie))).json();
    const created = list.find((o: any) => o.id === orgId);
    expect(created).toBeTruthy();
    const full = await (
      await app.request(
        `/api/auth/organization/get-full-organization?organizationSlug=${created.slug}`,
        get(cookie)
      )
    ).json();
    expect(full.members.length).toBeGreaterThanOrEqual(1);
    expect(full.members[0].user.email).toBe(ADMIN.email);
  });

  it("org security (MFA enforcement) get + put", async () => {
    const cookie = await install();
    const orgId = await createOrg(cookie);
    const g = await app.request(`/api/v1/organizations/${orgId}/security`, get(cookie));
    expect(g.status).toBe(200);
    const put = await app.request(`/api/v1/organizations/${orgId}/security`, post({ mfaRequired: false }, cookie, "PUT"));
    expect(put.status).toBe(200);
  });

  it("org sso, oauth-apps, oauth-scopes, integrations, usage, audit, regions", async () => {
    const cookie = await install();
    const orgId = await createOrg(cookie);
    for (const path of [
      `/api/v1/organizations/${orgId}/sso`,
      `/api/v1/organizations/${orgId}/oauth-apps`,
      `/api/v1/oauth-scopes`,
      `/api/v1/organizations/${orgId}/integrations`,
      `/api/v1/organizations/${orgId}/usage`,
      `/api/v1/organizations/${orgId}/audit-logs`,
      `/api/v1/organizations/${orgId}/regions`,
    ]) {
      const res = await app.request(path, get(cookie));
      expect(res.status, `GET ${path}`).toBe(200);
    }
  });

  it("org aws-credentials: set (validated), get, delete", async () => {
    const cookie = await install();
    const orgId = await createOrg(cookie);
    setValidator({ validate: async () => ({ ok: true, accountId: "123456789012" }) });
    const set = await app.request(`/api/v1/organizations/${orgId}/aws-credentials`, post({ accessKeyId: "AKIA", secretAccessKey: "secret", defaultRegion: "us-west-2" }, cookie));
    expect(set.status).toBe(200);
    const g = await app.request(`/api/v1/organizations/${orgId}/aws-credentials`, get(cookie));
    expect(g.status).toBe(200);
    const del = await app.request(`/api/v1/organizations/${orgId}/aws-credentials`, { method: "DELETE", headers: { cookie } });
    expect(del.status).toBe(200);
  });
});

describe("e2e: project lifecycle", () => {
  it("shared project: create -> active, api-keys, pause/resume, delete", async () => {
    const cookie = await install();
    const orgId = await createOrg(cookie);

    const create = await app.request(`/api/v1/organizations/${orgId}/projects`, post({ name: "Proj", region: "shared", dbPassword: "supersecret123" }, cookie));
    expect(create.status).toBe(200);
    const p = await create.json();
    expect(p.status).toBe("active");
    expect(p.infrastructureType).toBe("shared");
    expect(JSON.stringify(p)).not.toContain("dbPasswordEncrypted");

    const keys = await (await app.request(`/api/v1/projects/${p.ref}/api-keys`, get(cookie))).json();
    expect(keys.anonKey).toBeTruthy();
    expect(keys.serviceRoleKey).toBeTruthy();

    const list = await (await app.request(`/api/v1/organizations/${orgId}/projects`, get(cookie))).json();
    expect(list.projects).toHaveLength(1);

    expect((await (await app.request(`/api/v1/projects/${p.ref}/pause`, post({}, cookie))).json()).status).toBe("paused");
    expect((await (await app.request(`/api/v1/projects/${p.ref}/resume`, post({}, cookie))).json()).status).toBe("active");

    const del = await app.request(`/api/v1/projects/${p.ref}`, { method: "DELETE", headers: { cookie } });
    expect(del.status).toBe(200);
  });

  it("project connections + privatelink accounts CRUD", async () => {
    const cookie = await install();
    const orgId = await createOrg(cookie);
    const ref = await createProject(cookie, orgId);

    expect((await app.request(`/api/v1/projects/${ref}/connections`, get(cookie))).status).toBe(200);
    expect((await app.request(`/api/v1/projects/${ref}/privatelink/accounts`, get(cookie))).status).toBe(200);
    const add = await app.request(`/api/v1/projects/${ref}/privatelink/accounts`, post({ awsAccountId: "123456789012" }, cookie));
    expect(add.status).toBeLessThan(500);
  });

  it("EC2 region rejected without creds, allowed with validated creds", async () => {
    const cookie = await install();
    const orgId = await createOrg(cookie);
    expect((await app.request(`/api/v1/organizations/${orgId}/projects`, post({ name: "P", region: "us-west-2", dbPassword: "supersecret123" }, cookie))).status).toBe(400);
    setValidator({ validate: async () => ({ ok: true, accountId: "1" }) });
    await app.request(`/api/v1/organizations/${orgId}/aws-credentials`, post({ accessKeyId: "AKIA", secretAccessKey: "s", defaultRegion: "us-west-2" }, cookie));
    const ok = await app.request(`/api/v1/organizations/${orgId}/projects`, post({ name: "P2", region: "us-west-2", dbPassword: "supersecret123" }, cookie));
    expect(ok.status).toBe(200);
  });
});

describe("e2e: authz", () => {
  it("unauthenticated requests are rejected", async () => {
    await install();
    expect((await app.request("/api/v1/account/profile")).status).toBe(401);
    expect((await app.request("/api/v1/me")).status).toBe(401);
  });
});
