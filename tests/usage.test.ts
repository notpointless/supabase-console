import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/app";
import { setQueue, resetQueue, InlineQueue } from "../src/jobs/queue";
import { setProvisioner, resetProvisioner, StubProvisioner } from "../src/projects/provisioner";
import { setMailer, resetMailer } from "../src/email/mailer";
import { USAGE_METRICS } from "../src/usage/metrics";

const json = (body: unknown, cookie = "") => {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (cookie) h.cookie = cookie;
  return { method: "POST", headers: h, body: JSON.stringify(body) } as RequestInit;
};

async function installOwner(): Promise<string> {
  const r = await app.request(
    "/api/auth/install/setup",
    json({ name: "Admin", email: "admin@example.com", password: "supersecret123" }),
  );
  return r.headers.get("set-cookie") ?? "";
}

async function createOrg(cookie: string, name = "Acme"): Promise<string> {
  const r = await app.request(
    "/api/auth/organization/create",
    json({ name, type: "company" }, cookie),
  );
  return ((await r.json()) as { id: string }).id;
}

async function createProject(ownerCookie: string, orgId: string): Promise<void> {
  await app.request(
    `/api/v1/organizations/${orgId}/projects`,
    json({ name: "Test Project", region: "shared", dbPassword: "supersecret123" }, ownerCookie),
  );
}

describe("usage metrics", () => {
  beforeEach(() => {
    resetQueue();
    resetProvisioner();
    resetMailer();
    setQueue(new InlineQueue());
    setProvisioner(new StubProvisioner());
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/organizations/:orgId/usage — integration tests
  // ---------------------------------------------------------------------------

  describe("GET /api/v1/organizations/:orgId/usage", () => {
    it("member gets usage: billing null, required metric ids present, all used 0, projectCount reflects created projects", async () => {
      const cookie = await installOwner();
      const orgId = await createOrg(cookie);
      await createProject(cookie, orgId);

      const res = await app.request(`/api/v1/organizations/${orgId}/usage`, {
        headers: { cookie },
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        billing: null;
        projectCount: number;
        metrics: Array<{ id: string; label: string; unit: string; limit: number | null; used: number }>;
      };

      // Self-hosted: no billing
      expect(body.billing).toBeNull();

      // projectCount reflects the 1 project we created
      expect(body.projectCount).toBe(1);

      // metrics is an array
      expect(Array.isArray(body.metrics)).toBe(true);

      // Required metric ids
      const requiredIds = [
        "db_size",
        "egress",
        "monthly_active_users",
        "storage_size",
        "realtime_messages",
        "edge_function_invocations",
      ];
      for (const id of requiredIds) {
        const metric = body.metrics.find((m) => m.id === id);
        expect(metric, `metric ${id} should exist`).toBeDefined();
        expect(metric!.label, `metric ${id} label`).toBeTruthy();
        expect(metric!.unit, `metric ${id} unit`).toBeTruthy();
        // used is always 0 (real telemetry deferred)
        expect(metric!.used, `metric ${id} used`).toBe(0);
      }

      // Every metric has used === 0 (telemetry pipeline deferred)
      for (const m of body.metrics) {
        expect(m.used, `used for ${m.id}`).toBe(0);
        // Each metric shape: id, label, unit, limit, used
        expect(typeof m.id).toBe("string");
        expect(typeof m.label).toBe("string");
        expect(typeof m.unit).toBe("string");
      }
    });

    it("projectCount is 0 when no projects have been created", async () => {
      const cookie = await installOwner();
      const orgId = await createOrg(cookie);

      const res = await app.request(`/api/v1/organizations/${orgId}/usage`, {
        headers: { cookie },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { projectCount: number };
      expect(body.projectCount).toBe(0);
    });

    it("unauthenticated request → 401", async () => {
      const cookie = await installOwner();
      const orgId = await createOrg(cookie);
      const res = await app.request(`/api/v1/organizations/${orgId}/usage`);
      expect(res.status).toBe(401);
    });

    it("non-member of the org → 403", async () => {
      const ownerCookie = await installOwner();
      const org1Id = await createOrg(ownerCookie, "Org1");

      // Invite outsider to org1 so we can create their account
      let invId = "";
      setMailer({
        sendInvite: async (e) => {
          invId = new URL(e.acceptUrl).searchParams.get("invitationId") ?? "";
        },
      });
      await app.request(
        "/api/auth/organization/invite-member",
        json({ email: "outsider@example.com", role: "developer", organizationId: org1Id }, ownerCookie),
      );
      const accepted = await app.request(
        "/api/auth/invite/accept-new",
        json({ invitationId: invId, name: "Outsider", password: "supersecret123" }),
      );
      resetMailer();
      const outsiderCookie = accepted.headers.get("set-cookie") ?? "";

      // Create a second org that outsider is NOT a member of
      const org2Id = await createOrg(ownerCookie, "Org2");

      // outsider tries to read usage for org2 → 403
      const res = await app.request(`/api/v1/organizations/${org2Id}/usage`, {
        headers: { cookie: outsiderCookie },
      });
      expect(res.status).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // USAGE_METRICS catalog — unit tests
  // ---------------------------------------------------------------------------

  describe("USAGE_METRICS catalog (unit)", () => {
    it("has unique ids", () => {
      const ids = USAGE_METRICS.map((m) => m.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it("every metric has a non-empty label and unit", () => {
      for (const m of USAGE_METRICS) {
        expect(m.label.length, `metric ${m.id} label`).toBeGreaterThan(0);
        expect(m.unit.length, `metric ${m.id} unit`).toBeGreaterThan(0);
      }
    });
  });
});
