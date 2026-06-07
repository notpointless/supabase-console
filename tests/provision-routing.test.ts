import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/app";
import { setQueue, resetQueue, InlineQueue } from "../src/jobs/queue";
import { setComposeRunner, resetComposeRunner } from "../src/projects/stack/compose-runner";

const json = (body: unknown, cookie = "") => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return { method: "POST", headers, body: JSON.stringify(body) } as RequestInit;
};
const owner = async () => (await app.request("/api/auth/install/setup", json({ name: "Admin", email: "admin@example.com", password: "supersecret123" }))).headers.get("set-cookie") ?? "";
const org = async (c: string) => (await (await app.request("/api/auth/organization/create", json({ name: "Acme", type: "company" }, c))).json()).id;

describe("shared provisioning via worker", () => {
  beforeEach(() => { resetQueue(); setQueue(new InlineQueue()); resetComposeRunner(); });

  it("a shared project provisions via SharedInfra (fake docker) to active with apiUrl + ports", async () => {
    const ups: string[] = [];
    setComposeRunner({ up: async (_d, p) => { ups.push(p); }, stop: async () => {}, start: async () => {}, down: async () => {}, restart: async () => {} });
    const cookie = await owner();
    const orgId = await org(cookie);
    const res = await app.request(`/api/v1/organizations/${orgId}/projects`, json({ name: "P", region: "shared", dbPassword: "supersecret123" }, cookie));
    const p = await res.json();
    expect(p.status).toBe("active");
    expect(p.connection.apiUrl).toMatch(/^http:\/\/localhost:\d+$/);
    expect(p.kongHttpPort).toBeGreaterThanOrEqual(20000);
    expect(ups[0]).toBe(`sb-${p.ref}`);
    expect(JSON.stringify(p)).not.toMatch(/dbPasswordEncrypted|jwt|service_role/i);
  });

  it("provision failure marks the project failed", async () => {
    setComposeRunner({ up: async () => { throw new Error("docker down"); }, stop: async () => {}, start: async () => {}, down: async () => {}, restart: async () => {} });
    const cookie = await owner();
    const orgId = await org(cookie);
    const p = await (await app.request(`/api/v1/organizations/${orgId}/projects`, json({ name: "P", region: "shared", dbPassword: "supersecret123" }, cookie))).json();
    expect(p.status).toBe("failed");
    expect(p.failureReason).toContain("docker down");
  });
});
