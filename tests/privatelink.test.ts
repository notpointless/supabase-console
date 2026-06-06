import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/app";
import { setMailer, resetMailer } from "../src/email/mailer";
import { setQueue, resetQueue, InlineQueue } from "../src/jobs/queue";
import { setProvisioner, resetProvisioner, StubProvisioner } from "../src/projects/provisioner";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function addDeveloper(ownerCookie: string, orgId: string): Promise<string> {
  let inv = "";
  setMailer({
    sendInvite: async (e) => {
      inv = new URL(e.acceptUrl).searchParams.get("invitationId") ?? "";
    },
  });
  await app.request(
    "/api/auth/organization/invite-member",
    json({ email: "dev@example.com", role: "developer", organizationId: orgId }, ownerCookie),
  );
  const r = await app.request(
    "/api/auth/invite/accept-new",
    json({ invitationId: inv, name: "Dev User", password: "supersecret123" }),
  );
  resetMailer();
  return r.headers.get("set-cookie") ?? "";
}

async function createProject(ownerCookie: string, orgId: string): Promise<string> {
  const r = await app.request(
    `/api/v1/organizations/${orgId}/projects`,
    json({ name: "Test Project", region: "shared", dbPassword: "supersecret123" }, ownerCookie),
  );
  return ((await r.json()) as { ref: string }).ref;
}

// ---------------------------------------------------------------------------
// AWS PrivateLink allowed-accounts tests
//
// NOTE: Actual VPC endpoint-service provisioning is DEFERRED.
//       These tests cover the account allowlist data model + API only.
// ---------------------------------------------------------------------------

describe("AWS PrivateLink allowed accounts", () => {
  beforeEach(() => {
    resetMailer();
    resetQueue();
    resetProvisioner();
    setQueue(new InlineQueue());
    setProvisioner(new StubProvisioner());
  });

  // -------------------------------------------------------------------------
  // Happy-path: add an account, list it, delete it
  // -------------------------------------------------------------------------

  it("owner adds a valid 12-digit AWS account ID → 200 and status is pending", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);
    const ref = await createProject(cookie, orgId);

    const res = await app.request(
      `/api/v1/projects/${ref}/privatelink/accounts`,
      json({ awsAccountId: "123456789012" }, cookie),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; awsAccountId: string; status: string };
    expect(body.awsAccountId).toBe("123456789012");
    expect(body.status).toBe("pending");
    expect(body.id).toBeTruthy();
  });

  it("GET lists the added account with id, awsAccountId, and status", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);
    const ref = await createProject(cookie, orgId);

    await app.request(
      `/api/v1/projects/${ref}/privatelink/accounts`,
      json({ awsAccountId: "123456789012" }, cookie),
    );

    const res = await app.request(`/api/v1/projects/${ref}/privatelink/accounts`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: Array<{ id: string; awsAccountId: string; status: string }> };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]!.awsAccountId).toBe("123456789012");
    expect(body.accounts[0]!.status).toBe("pending");
    expect(body.accounts[0]!.id).toBeTruthy();
  });

  it("DELETE removes the account", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);
    const ref = await createProject(cookie, orgId);

    const addRes = await app.request(
      `/api/v1/projects/${ref}/privatelink/accounts`,
      json({ awsAccountId: "123456789012" }, cookie),
    );
    const { id } = (await addRes.json()) as { id: string };

    const del = await app.request(`/api/v1/projects/${ref}/privatelink/accounts/${id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(del.status).toBe(200);

    const listRes = await app.request(`/api/v1/projects/${ref}/privatelink/accounts`, {
      headers: { cookie },
    });
    const list = (await listRes.json()) as { accounts: unknown[] };
    expect(list.accounts).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Validation: AWS account ID must be exactly 12 digits
  // -------------------------------------------------------------------------

  it("rejects an account ID shorter than 12 digits → 400", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);
    const ref = await createProject(cookie, orgId);

    const res = await app.request(
      `/api/v1/projects/${ref}/privatelink/accounts`,
      json({ awsAccountId: "12345" }, cookie),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an account ID longer than 12 digits → 400", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);
    const ref = await createProject(cookie, orgId);

    const res = await app.request(
      `/api/v1/projects/${ref}/privatelink/accounts`,
      json({ awsAccountId: "1234567890123" }, cookie),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an account ID containing non-digit characters → 400", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);
    const ref = await createProject(cookie, orgId);

    const res = await app.request(
      `/api/v1/projects/${ref}/privatelink/accounts`,
      json({ awsAccountId: "12345678901x" }, cookie),
    );
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Duplicate: adding same account ID twice → 409 account_exists
  // -------------------------------------------------------------------------

  it("adding the same AWS account ID twice → 409 account_exists", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);
    const ref = await createProject(cookie, orgId);

    await app.request(
      `/api/v1/projects/${ref}/privatelink/accounts`,
      json({ awsAccountId: "123456789012" }, cookie),
    );

    const res = await app.request(
      `/api/v1/projects/${ref}/privatelink/accounts`,
      json({ awsAccountId: "123456789012" }, cookie),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("account_exists");
  });

  // -------------------------------------------------------------------------
  // Authorization: developer cannot add or delete accounts (403)
  // -------------------------------------------------------------------------

  it("developer cannot add an AWS account → 403", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);
    const devCookie = await addDeveloper(cookie, orgId);
    const ref = await createProject(cookie, orgId);

    const res = await app.request(
      `/api/v1/projects/${ref}/privatelink/accounts`,
      json({ awsAccountId: "123456789012" }, devCookie),
    );
    expect(res.status).toBe(403);
  });

  it("developer cannot delete an AWS account → 403", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);
    const ref = await createProject(cookie, orgId);

    const addRes = await app.request(
      `/api/v1/projects/${ref}/privatelink/accounts`,
      json({ awsAccountId: "123456789012" }, cookie),
    );
    const { id } = (await addRes.json()) as { id: string };

    const devCookie = await addDeveloper(cookie, orgId);
    const res = await app.request(`/api/v1/projects/${ref}/privatelink/accounts/${id}`, {
      method: "DELETE",
      headers: { cookie: devCookie },
    });
    expect(res.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Unauthenticated → 401
  // -------------------------------------------------------------------------

  it("unauthenticated GET returns 401", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);
    const ref = await createProject(cookie, orgId);

    const res = await app.request(`/api/v1/projects/${ref}/privatelink/accounts`);
    expect(res.status).toBe(401);
  });

  it("unauthenticated POST returns 401", async () => {
    const cookie = await installOwner();
    const orgId = await createOrg(cookie);
    const ref = await createProject(cookie, orgId);

    const res = await app.request(`/api/v1/projects/${ref}/privatelink/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ awsAccountId: "123456789012" }),
    });
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Cross-org: member of a different org cannot access another org's project
  // -------------------------------------------------------------------------

  it("member of different org cannot GET another org's privatelink accounts → 403", async () => {
    const ownerCookie = await installOwner();
    const orgId = await createOrg(ownerCookie, "Org A");
    const ref = await createProject(ownerCookie, orgId);

    // Create second org (owner is also in it but the project belongs to orgId)
    const orgBId = await createOrg(ownerCookie, "Org B");

    // Add a developer to Org B only
    let inv = "";
    setMailer({
      sendInvite: async (e) => {
        inv = new URL(e.acceptUrl).searchParams.get("invitationId") ?? "";
      },
    });
    await app.request(
      "/api/auth/organization/invite-member",
      json({ email: "devb@example.com", role: "developer", organizationId: orgBId }, ownerCookie),
    );
    const devBRes = await app.request(
      "/api/auth/invite/accept-new",
      json({ invitationId: inv, name: "Dev B", password: "supersecret123" }),
    );
    resetMailer();
    const devBCookie = devBRes.headers.get("set-cookie") ?? "";

    // devB is not a member of orgId; they should get 403 trying to read orgId's project
    const res = await app.request(`/api/v1/projects/${ref}/privatelink/accounts`, {
      headers: { cookie: devBCookie },
    });
    expect(res.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Unknown project ref → 404
  // -------------------------------------------------------------------------

  it("unknown project ref → 404", async () => {
    const cookie = await installOwner();
    await createOrg(cookie);

    const res = await app.request(`/api/v1/projects/nonexistentref/privatelink/accounts`, {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });
});
