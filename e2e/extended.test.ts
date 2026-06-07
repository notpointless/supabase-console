/**
 * Extended end-to-end coverage for the control-plane API.
 *
 * Complements full-flow.test.ts with deeper per-area cases: auth/session,
 * account profile + access tokens, organization settings persistence, project
 * lifecycle edge cases, AWS credential gating, validation, and authorization.
 * Runs in-process (Hono app.request) against a testcontainer Postgres with the
 * inline queue, stub provisioner, and a mockable AWS validator.
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
const json = async (r: Response) => r.json();

async function install(): Promise<string> {
  const r = await app.request("/api/auth/install/setup", post(ADMIN));
  return r.headers.get("set-cookie") ?? "";
}
async function createOrg(cookie: string, name = "Acme"): Promise<{ id: string; slug: string }> {
  const r = await app.request("/api/auth/organization/create", post({ name, type: "company" }, cookie));
  const o = await r.json();
  return { id: o.id, slug: o.slug };
}
async function createProject(cookie: string, orgId: string, name = "Proj", region = "shared") {
  const r = await app.request(
    `/api/v1/organizations/${orgId}/projects`,
    post({ name, region, dbPassword: "supersecret123" }, cookie)
  );
  return r;
}

beforeEach(() => {
  resetQueue();
  resetValidator();
  resetProvisioner();
  setQueue(new InlineQueue());
  setProvisioner(new StubProvisioner());
});

describe("e2e-ext: auth & session", () => {
  it("rejects wrong password", async () => {
    await install();
    const r = await app.request("/api/auth/sign-in/email", post({ email: ADMIN.email, password: "wrong-password-xx" }));
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects sign-in for unknown email", async () => {
    await install();
    const r = await app.request("/api/auth/sign-in/email", post({ email: "nobody@example.com", password: "supersecret123" }));
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it("session cookie authorizes /api/v1/me; absent cookie is 401", async () => {
    const cookie = await install();
    expect((await app.request("/api/v1/me", get(cookie))).status).toBe(200);
    expect((await app.request("/api/v1/me")).status).toBe(401);
  });

  it("install status is idempotent and stays installed", async () => {
    await install();
    for (let i = 0; i < 3; i++) {
      expect(await json(await app.request("/api/auth/install/status"))).toEqual({ installed: true });
    }
  });
});

describe("e2e-ext: account profile", () => {
  it("partial update keeps other fields", async () => {
    const cookie = await install();
    await app.request("/api/v1/account/profile", post({ firstName: "Aa", lastName: "Bb" }, cookie, "PUT"));
    const upd = await json(await app.request("/api/v1/account/profile", post({ firstName: "Cc" }, cookie, "PUT")));
    expect(upd.firstName).toBe("Cc");
    expect(upd.lastName).toBe("Bb");
  });

  it("profile never leaks credential material", async () => {
    const cookie = await install();
    const body = JSON.stringify(await json(await app.request("/api/v1/account/profile", get(cookie))));
    expect(body).not.toMatch(/passwordHash|password_hash|\"password\"/i);
  });

  it("profile reports platform admin for the first user", async () => {
    const cookie = await install();
    const p = await json(await app.request("/api/v1/account/profile", get(cookie)));
    expect(p.isPlatformAdmin).toBe(true);
  });

  it("unauthenticated profile is 401", async () => {
    await install();
    expect((await app.request("/api/v1/account/profile")).status).toBe(401);
  });
});

describe("e2e-ext: access tokens", () => {
  it("supports multiple tokens and independent deletion", async () => {
    const cookie = await install();
    const a = await json(await app.request("/api/v1/account/access-tokens", post({ name: "a", type: "classic" }, cookie)));
    const b = await json(await app.request("/api/v1/account/access-tokens", post({ name: "b", type: "classic" }, cookie)));
    expect(a.token).toMatch(/^sbp_/);
    expect(b.token).toMatch(/^sbp_/);
    let list = await json(await app.request("/api/v1/account/access-tokens", get(cookie)));
    expect(list.length).toBe(2);
    await app.request(`/api/v1/account/access-tokens/${a.id}`, { method: "DELETE", headers: { cookie } });
    list = await json(await app.request("/api/v1/account/access-tokens", get(cookie)));
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(b.id);
  });

  it("raw token is returned once and never re-listed", async () => {
    const cookie = await install();
    const t = await json(await app.request("/api/v1/account/access-tokens", post({ name: "x", type: "classic" }, cookie)));
    const list = JSON.stringify(await json(await app.request("/api/v1/account/access-tokens", get(cookie))));
    expect(list).not.toContain(t.token);
  });

  it("requires authentication", async () => {
    await install();
    expect((await app.request("/api/v1/account/access-tokens")).status).toBe(401);
  });
});

describe("e2e-ext: organizations", () => {
  it("supports multiple orgs, each listed with a unique slug", async () => {
    const cookie = await install();
    const a = await createOrg(cookie, "Acme");
    const b = await createOrg(cookie, "Globex");
    const list = await json(await app.request("/api/auth/organization/list", get(cookie)));
    const slugs = list.map((o: any) => o.slug);
    expect(slugs).toContain(a.slug);
    expect(slugs).toContain(b.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("security MFA toggle persists", async () => {
    const cookie = await install();
    const { id } = await createOrg(cookie);
    await app.request(`/api/v1/organizations/${id}/security`, post({ mfaRequired: true }, cookie, "PUT"));
    const g = await json(await app.request(`/api/v1/organizations/${id}/security`, get(cookie)));
    expect(g.mfaRequired ?? g.enforceMfa ?? g.mfa_required).toBe(true);
  });

  it("owner is a member of a newly created org", async () => {
    const cookie = await install();
    const { slug } = await createOrg(cookie);
    const full = await json(
      await app.request(`/api/auth/organization/get-full-organization?organizationSlug=${slug}`, get(cookie))
    );
    expect(full.members.length).toBeGreaterThanOrEqual(1);
    expect(full.members[0].user.email).toBe(ADMIN.email);
  });

  it("regions list includes shared", async () => {
    const cookie = await install();
    const { id } = await createOrg(cookie);
    const r = await json(await app.request(`/api/v1/organizations/${id}/regions`, get(cookie)));
    const regions = r.regions ?? r;
    expect(JSON.stringify(regions)).toMatch(/shared/i);
  });

  it("usage + audit endpoints are reachable", async () => {
    const cookie = await install();
    const { id } = await createOrg(cookie);
    expect((await app.request(`/api/v1/organizations/${id}/usage`, get(cookie))).status).toBe(200);
    expect((await app.request(`/api/v1/organizations/${id}/audit-logs`, get(cookie))).status).toBe(200);
  });
});

describe("e2e-ext: AWS credentials gating", () => {
  it("rejects invalid credentials (validator says no)", async () => {
    const cookie = await install();
    const { id } = await createOrg(cookie);
    setValidator({ validate: async () => ({ ok: false, error: "bad" }) as any });
    const r = await app.request(`/api/v1/organizations/${id}/aws-credentials`, post({ accessKeyId: "AKIA", secretAccessKey: "s", defaultRegion: "us-east-1" }, cookie));
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it("validated creds unlock an EC2 region; deleting them re-blocks it", async () => {
    const cookie = await install();
    const { id } = await createOrg(cookie);
    expect((await createProject(cookie, id, "P", "us-west-2")).status).toBe(400);
    setValidator({ validate: async () => ({ ok: true, accountId: "1" }) });
    await app.request(`/api/v1/organizations/${id}/aws-credentials`, post({ accessKeyId: "AKIA", secretAccessKey: "s", defaultRegion: "us-west-2" }, cookie));
    expect((await createProject(cookie, id, "P2", "us-west-2")).status).toBe(200);
    await app.request(`/api/v1/organizations/${id}/aws-credentials`, { method: "DELETE", headers: { cookie } });
    expect((await createProject(cookie, id, "P3", "us-west-2")).status).toBe(400);
  });

  it("credentials require owner/admin (unauthenticated rejected)", async () => {
    const cookie = await install();
    const { id } = await createOrg(cookie);
    expect((await app.request(`/api/v1/organizations/${id}/aws-credentials`)).status).toBe(401);
  });
});

describe("e2e-ext: project lifecycle edge cases", () => {
  it("creates multiple projects scoped to their org", async () => {
    const cookie = await install();
    const a = await createOrg(cookie, "Acme");
    const b = await createOrg(cookie, "Globex");
    await createProject(cookie, a.id, "A1");
    await createProject(cookie, a.id, "A2");
    await createProject(cookie, b.id, "B1");
    const aList = await json(await app.request(`/api/v1/organizations/${a.id}/projects`, get(cookie)));
    const bList = await json(await app.request(`/api/v1/organizations/${b.id}/projects`, get(cookie)));
    expect(aList.projects).toHaveLength(2);
    expect(bList.projects).toHaveLength(1);
  });

  it("shared project becomes active with a connection and hides its password", async () => {
    const cookie = await install();
    const { id } = await createOrg(cookie);
    const p = await json(await createProject(cookie, id));
    expect(p.status).toBe("active");
    expect(p.connection.ref).toBe(p.ref);
    expect(JSON.stringify(p)).not.toContain("dbPasswordEncrypted");
  });

  it("api-keys expose anon + service role", async () => {
    const cookie = await install();
    const { id } = await createOrg(cookie);
    const p = await json(await createProject(cookie, id));
    const keys = await json(await app.request(`/api/v1/projects/${p.ref}/api-keys`, get(cookie)));
    expect(keys.anonKey).toBeTruthy();
    expect(keys.serviceRoleKey).toBeTruthy();
  });

  it("pause then resume is reflected in status", async () => {
    const cookie = await install();
    const { id } = await createOrg(cookie);
    const p = await json(await createProject(cookie, id));
    expect((await json(await app.request(`/api/v1/projects/${p.ref}/pause`, post({}, cookie)))).status).toBe("paused");
    expect((await json(await app.request(`/api/v1/projects/${p.ref}/resume`, post({}, cookie)))).status).toBe("active");
  });

  it("delete removes the project from the org list", async () => {
    const cookie = await install();
    const { id } = await createOrg(cookie);
    const p = await json(await createProject(cookie, id));
    await app.request(`/api/v1/projects/${p.ref}`, { method: "DELETE", headers: { cookie } });
    const list = await json(await app.request(`/api/v1/organizations/${id}/projects`, get(cookie)));
    expect(list.projects.find((x: any) => x.ref === p.ref)).toBeFalsy();
  });

  it("get by unknown ref is 404", async () => {
    const cookie = await install();
    expect((await app.request(`/api/v1/projects/doesnotexist0000000`, get(cookie))).status).toBe(404);
  });
});

describe("e2e-ext: validation", () => {
  it("rejects a short db password", async () => {
    const cookie = await install();
    const { id } = await createOrg(cookie);
    const r = await app.request(`/api/v1/organizations/${id}/projects`, post({ name: "P", region: "shared", dbPassword: "short" }, cookie));
    expect(r.status).toBe(400);
  });

  it("rejects an unknown region", async () => {
    const cookie = await install();
    const { id } = await createOrg(cookie);
    const r = await app.request(`/api/v1/organizations/${id}/projects`, post({ name: "P", region: "mars-1", dbPassword: "supersecret123" }, cookie));
    expect(r.status).toBe(400);
  });

  it("rejects a missing project name", async () => {
    const cookie = await install();
    const { id } = await createOrg(cookie);
    const r = await app.request(`/api/v1/organizations/${id}/projects`, post({ region: "shared", dbPassword: "supersecret123" }, cookie));
    expect(r.status).toBe(400);
  });

  it("rejects malformed aws-credentials payloads", async () => {
    const cookie = await install();
    const { id } = await createOrg(cookie);
    const r = await app.request(`/api/v1/organizations/${id}/aws-credentials`, post({ accessKeyId: "" }, cookie));
    expect(r.status).toBe(400);
  });
});

describe("e2e-ext: authorization", () => {
  it("project actions require a session", async () => {
    const cookie = await install();
    const { id } = await createOrg(cookie);
    const p = await json(await createProject(cookie, id));
    expect((await app.request(`/api/v1/projects/${p.ref}`)).status).toBe(401);
    expect((await app.request(`/api/v1/projects/${p.ref}/api-keys`)).status).toBe(401);
    expect((await app.request(`/api/v1/projects/${p.ref}/pause`, post({}))).status).toBe(401);
  });

  it("org endpoints require a session", async () => {
    const cookie = await install();
    const { id } = await createOrg(cookie);
    expect((await app.request(`/api/v1/organizations/${id}/projects`)).status).toBe(401);
    expect((await app.request(`/api/v1/organizations/${id}/usage`)).status).toBe(401);
    expect((await app.request(`/api/v1/organizations/${id}/audit-logs`)).status).toBe(401);
  });

  it("install setup is rejected once installed", async () => {
    await install();
    expect((await app.request("/api/auth/install/setup", post(ADMIN))).status).toBe(409);
  });
});
