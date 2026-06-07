/**
 * account-profile.test.ts
 *
 * End-to-end tests for:
 *   GET  /api/v1/account/profile
 *   PUT  /api/v1/account/profile
 *   POST /api/v1/account/delete
 *
 * Uses the in-process Hono app (no real server) against the vitest
 * Testcontainers PostgreSQL database (spun up in tests/helpers/setup.ts).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/app";
import { setMailer, resetMailer } from "../src/email/mailer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const json = (body: unknown, cookie = ""): RequestInit => {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (cookie) h.cookie = cookie;
  return { method: "POST", headers: h, body: JSON.stringify(body) };
};

async function installAndLogin(): Promise<string> {
  const r = await app.request(
    "/api/auth/install/setup",
    json({ name: "Admin", email: "admin@example.com", password: "supersecret123" }),
  );
  expect(r.status).toBe(200);
  const cookie = r.headers.get("set-cookie") ?? "";
  expect(cookie).toBeTruthy();
  return cookie;
}

/**
 * Invite a brand-new user into an org and return their session cookie.
 * The invited user is given the "developer" role (non-admin).
 */
async function createOrgAndInviteMember(
  ownerCookie: string,
  memberEmail: string,
): Promise<string> {
  // Create an org to invite into.
  const orgRes = await app.request(
    "/api/auth/organization/create",
    json({ name: "Test Org", type: "company" }, ownerCookie),
  );
  expect(orgRes.status).toBe(200);
  const { id: orgId } = (await orgRes.json()) as { id: string };

  // Capture the invitation ID via the mailer stub.
  let invitationId = "";
  setMailer({
    sendInvite: async (e) => {
      invitationId = new URL(e.acceptUrl).searchParams.get("invitationId") ?? "";
    },
  });

  const inviteRes = await app.request(
    "/api/auth/organization/invite-member",
    json({ email: memberEmail, role: "developer", organizationId: orgId }, ownerCookie),
  );
  expect(inviteRes.status).toBe(200);
  expect(invitationId).toBeTruthy();

  // Accept as a brand-new user.
  const acceptRes = await app.request(
    "/api/auth/invite/accept-new",
    json({ invitationId, name: "Dev User", password: "supersecret123" }),
  );
  expect(acceptRes.status).toBe(200);
  const memberCookie = acceptRes.headers.get("set-cookie") ?? "";
  expect(memberCookie).toBeTruthy();
  return memberCookie;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("account profile", () => {
  beforeEach(() => resetMailer());

  // ── GET profile ──────────────────────────────────────────────────────────

  it("GET /api/v1/account/profile (admin) → 200 with email and isPlatformAdmin true", async () => {
    const cookie = await installAndLogin();

    const res = await app.request("/api/v1/account/profile", { headers: { cookie } });
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.email).toBe("admin@example.com");
    expect(body.isPlatformAdmin).toBe(true);

    // Must never expose password or hash fields.
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/password/i);
    expect(text).not.toMatch(/\bhash\b/i);
  });

  it("unauthenticated GET → 401", async () => {
    await installAndLogin(); // ensure installed
    const res = await app.request("/api/v1/account/profile");
    expect(res.status).toBe(401);
  });

  // ── PUT profile ──────────────────────────────────────────────────────────

  it("PUT /api/v1/account/profile updates fields and GET reflects them; no password/hash in response", async () => {
    const cookie = await installAndLogin();

    const putRes = await app.request("/api/v1/account/profile", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        firstName: "Z",
        lastName: "V",
        displayName: "zee",
        username: "zeljko",
      }),
    });
    expect(putRes.status).toBe(200);

    const putBody = (await putRes.json()) as Record<string, unknown>;
    expect(putBody.firstName).toBe("Z");
    expect(putBody.lastName).toBe("V");
    expect(putBody.displayName).toBe("zee");
    expect(putBody.username).toBe("zeljko");

    // PUT response must not contain password/hash.
    const putText = JSON.stringify(putBody);
    expect(putText).not.toMatch(/password/i);
    expect(putText).not.toMatch(/\bhash\b/i);

    // GET must reflect the updated values.
    const getRes = await app.request("/api/v1/account/profile", { headers: { cookie } });
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as Record<string, unknown>;
    expect(getBody.firstName).toBe("Z");
    expect(getBody.lastName).toBe("V");
    expect(getBody.displayName).toBe("zee");
    expect(getBody.username).toBe("zeljko");

    // GET response must not contain password/hash.
    const getText = JSON.stringify(getBody);
    expect(getText).not.toMatch(/password/i);
    expect(getText).not.toMatch(/\bhash\b/i);
  });

  it("unauthenticated PUT → 401", async () => {
    await installAndLogin();
    const res = await app.request("/api/v1/account/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstName: "X" }),
    });
    expect(res.status).toBe(401);
  });

  // ── POST /account/delete ─────────────────────────────────────────────────

  it("admin POST /api/v1/account/delete → 403 cannot_delete_admin; admin profile still accessible", async () => {
    const cookie = await installAndLogin();

    const delRes = await app.request("/api/v1/account/delete", json({}, cookie));
    expect(delRes.status).toBe(403);
    const body = (await delRes.json()) as { error: { code: string } };
    expect(body.error.code).toBe("cannot_delete_admin");

    // Admin must still exist — GET profile still 200.
    const profileRes = await app.request("/api/v1/account/profile", { headers: { cookie } });
    expect(profileRes.status).toBe(200);
  });

  it("non-admin POST /api/v1/account/delete → 200; subsequent GET → 401", async () => {
    const adminCookie = await installAndLogin();
    const memberCookie = await createOrgAndInviteMember(adminCookie, "dev@example.com");

    // Non-admin profile must have isPlatformAdmin false.
    const profileBefore = await app.request("/api/v1/account/profile", {
      headers: { cookie: memberCookie },
    });
    expect(profileBefore.status).toBe(200);
    const profileBody = (await profileBefore.json()) as { isPlatformAdmin: boolean };
    expect(profileBody.isPlatformAdmin).toBe(false);

    // Delete the non-admin account.
    const delRes = await app.request("/api/v1/account/delete", json({}, memberCookie));
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { ok: boolean };
    expect(delBody.ok).toBe(true);

    // Session is now invalid — profile must return 401.
    const profileAfter = await app.request("/api/v1/account/profile", {
      headers: { cookie: memberCookie },
    });
    expect(profileAfter.status).toBe(401);
  });

  it("unauthenticated POST /account/delete → 401", async () => {
    await installAndLogin();
    const res = await app.request("/api/v1/account/delete", json({}));
    expect(res.status).toBe(401);
  });
});
