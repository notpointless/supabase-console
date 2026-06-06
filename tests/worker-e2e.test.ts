import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { app } from "../src/app";
import { resetQueue, setQueue, GraphileQueue } from "../src/jobs/queue";
import { startWorker } from "../src/jobs/worker";

const json = (body: unknown, cookie = "") => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return { method: "POST", headers, body: JSON.stringify(body) } as RequestInit;
};

let runner: Awaited<ReturnType<typeof startWorker>> | undefined;

describe("real graphile worker", () => {
  beforeEach(() => resetQueue());
  afterAll(async () => { await runner?.stop?.(); });

  it("provisions a project asynchronously via the real worker", async () => {
    setQueue(new GraphileQueue(process.env.DATABASE_URL!));
    runner = await startWorker();

    const cookie = (await app.request("/api/auth/install/setup", json({ name: "Admin", email: "admin@example.com", password: "supersecret123" }))).headers.get("set-cookie") ?? "";
    const orgId = (await (await app.request("/api/auth/organization/create", json({ name: "Acme", type: "company" }, cookie))).json()).id;
    const ref = (await (await app.request(`/api/v1/organizations/${orgId}/projects`, json({ name: "P", region: "shared", dbPassword: "supersecret123" }, cookie))).json()).ref;

    let status = "provisioning";
    for (let i = 0; i < 40 && status !== "active"; i++) {
      await new Promise((r) => setTimeout(r, 250));
      status = (await (await app.request(`/api/v1/projects/${ref}`, { headers: { cookie } })).json()).status;
    }
    expect(status).toBe("active");
  });
});
