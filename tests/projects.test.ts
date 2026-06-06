import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/app";
import { setQueue, resetQueue, InlineQueue } from "../src/jobs/queue";
import { setValidator, resetValidator } from "../src/aws/credential-validator";
import { setProvisioner, resetProvisioner, StubProvisioner } from "../src/projects/provisioner";

const json = (body: unknown, cookie = "") => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return { method: "POST", headers, body: JSON.stringify(body) } as RequestInit;
};

async function owner(): Promise<string> {
  const r = await app.request("/api/auth/install/setup", json({ name: "Admin", email: "admin@example.com", password: "supersecret123" }));
  return r.headers.get("set-cookie") ?? "";
}
async function org(cookie: string): Promise<string> {
  return (await (await app.request("/api/auth/organization/create", json({ name: "Acme", type: "company" }, cookie))).json()).id;
}

describe("projects", () => {
  beforeEach(() => { resetQueue(); resetValidator(); resetProvisioner(); setQueue(new InlineQueue()); setProvisioner(new StubProvisioner()); });

  it("creates a shared project that becomes active with a connection, password never returned", async () => {
    const cookie = await owner();
    const orgId = await org(cookie);
    const res = await app.request(`/api/v1/organizations/${orgId}/projects`, json({ name: "Proj", region: "shared", dbPassword: "supersecret123" }, cookie));
    expect(res.status).toBe(200);
    const p = await res.json();
    expect(p.ref).toMatch(/^[a-z]{20}$/);
    expect(p.infrastructureType).toBe("shared");
    expect(p.status).toBe("active");
    expect(p.connection.ref).toBe(p.ref);
    expect(JSON.stringify(p)).not.toContain("dbPasswordEncrypted");
  });

  it("rejects an EC2 region without validated creds, allows it with creds", async () => {
    const cookie = await owner();
    const orgId = await org(cookie);
    const noCreds = await app.request(`/api/v1/organizations/${orgId}/projects`, json({ name: "P", region: "us-west-2", dbPassword: "supersecret123" }, cookie));
    expect(noCreds.status).toBe(400);

    setValidator({ validate: async () => ({ ok: true, accountId: "1" }) });
    await app.request(`/api/v1/organizations/${orgId}/aws-credentials`, json({ accessKeyId: "AKIA", secretAccessKey: "s", defaultRegion: "us-west-2" }, cookie));
    const withCreds = await app.request(`/api/v1/organizations/${orgId}/projects`, json({ name: "P", region: "us-west-2", dbPassword: "supersecret123" }, cookie));
    expect(withCreds.status).toBe(200);
    expect((await withCreds.json()).infrastructureType).toBe("dedicated_ec2");
  });

  it("rejects an unknown region", async () => {
    const cookie = await owner();
    const orgId = await org(cookie);
    const res = await app.request(`/api/v1/organizations/${orgId}/projects`, json({ name: "P", region: "mars-1", dbPassword: "supersecret123" }, cookie));
    expect(res.status).toBe(400);
  });

  it("lists, gets, pauses, resumes, and deletes", async () => {
    const cookie = await owner();
    const orgId = await org(cookie);
    const ref = (await (await app.request(`/api/v1/organizations/${orgId}/projects`, json({ name: "P", region: "shared", dbPassword: "supersecret123" }, cookie))).json()).ref;

    const list = await (await app.request(`/api/v1/organizations/${orgId}/projects`, { headers: { cookie } })).json();
    expect(list.projects).toHaveLength(1);

    const got = await app.request(`/api/v1/projects/${ref}`, { headers: { cookie } });
    expect(got.status).toBe(200);

    const paused = await (await app.request(`/api/v1/projects/${ref}/pause`, json({}, cookie))).json();
    expect(paused.status).toBe("paused");
    const resumed = await (await app.request(`/api/v1/projects/${ref}/resume`, json({}, cookie))).json();
    expect(resumed.status).toBe("active");

    const del = await app.request(`/api/v1/projects/${ref}`, { method: "DELETE", headers: { cookie } });
    expect(del.status).toBe(200);
    const gone = await app.request(`/api/v1/projects/${ref}`, { headers: { cookie } });
    expect(gone.status).toBe(404);
  });

  it("requires auth (401)", async () => {
    const cookie = await owner();
    const orgId = await org(cookie);
    const unauth = await app.request(`/api/v1/organizations/${orgId}/projects`, json({ name: "P", region: "shared", dbPassword: "supersecret123" }));
    expect(unauth.status).toBe(401);
  });

  it("generates per-project secrets at create", async () => {
    const { getProjectSecrets } = await import("../src/projects/secrets");
    const { getProjectByRef } = await import("../src/projects/service");
    const cookie = await owner();
    const orgId = await org(cookie);
    const ref = (await (await app.request(`/api/v1/organizations/${orgId}/projects`, json({ name: "P", region: "shared", dbPassword: "supersecret123" }, cookie))).json()).ref;
    const row = await getProjectByRef(ref);
    const secrets = await getProjectSecrets(row!.id);
    expect(secrets).toBeDefined();
    expect(secrets!.anonKey.split(".")).toHaveLength(3);
  });
});
