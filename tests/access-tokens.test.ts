import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/app";
import { setMailer, resetMailer } from "../src/email/mailer";

const json = (body: unknown, cookie = "") => {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (cookie) h.cookie = cookie;
  return { method: "POST", headers: h, body: JSON.stringify(body) } as RequestInit;
};

async function installAndLogin(): Promise<string> {
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

/** Invite a brand-new user into an org and return their session cookie. */
async function addMember(
  ownerCookie: string,
  orgId: string,
  email: string,
  role = "developer",
): Promise<string> {
  let invitationId = "";
  setMailer({
    sendInvite: async (e) => {
      invitationId = new URL(e.acceptUrl).searchParams.get("invitationId") ?? "";
    },
  });
  await app.request(
    "/api/auth/organization/invite-member",
    json({ email, role, organizationId: orgId }, ownerCookie),
  );
  const r = await app.request(
    "/api/auth/invite/accept-new",
    json({ invitationId, name: "Member", password: "supersecret123" }),
  );
  return r.headers.get("set-cookie") ?? "";
}

describe("account access tokens (PATs)", () => {
  beforeEach(() => resetMailer());

  it("create returns token (raw, starts with sbp_) + id + name + type; list contains id/name/start but not the raw token", async () => {
    const cookie = await installAndLogin();

    // Create a token
    const createRes = await app.request(
      "/api/v1/account/access-tokens",
      json({ name: "my-token", type: "classic" }, cookie),
    );
    expect(createRes.status).toBe(200);

    const created = (await createRes.json()) as {
      id: string;
      name: string;
      token: string;
      type: string;
      expiresAt: string | null;
    };

    expect(created.id).toBeTruthy();
    expect(created.name).toBe("my-token");
    expect(created.type).toBe("classic");
    expect(created.token).toBeTruthy();
    expect(created.token).toMatch(/^sbp_/);

    const rawToken = created.token;

    // List must contain the entry but NEVER the raw token or a `key` field
    const listRes = await app.request("/api/v1/account/access-tokens", {
      headers: { cookie },
    });
    expect(listRes.status).toBe(200);
    const listText = await listRes.text();
    const list = JSON.parse(listText) as Array<{
      id: string;
      name: string;
      start: string | null;
      prefix: string | null;
      type: string;
      createdAt: string;
      expiresAt: string | null;
    }>;

    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(created.id);
    expect(list[0]!.name).toBe("my-token");
    expect(list[0]!.type).toBe("classic");
    // start and prefix are present (from plugin)
    expect(list[0]!.start).toBeTruthy();
    expect(list[0]!.prefix).toBeTruthy();

    // The raw token and the `key` hash must never appear in the list response
    expect(listText).not.toContain(rawToken);
    expect(list[0]).not.toHaveProperty("key");
  });

  it("a second GET still never exposes the raw token or a key field", async () => {
    const cookie = await installAndLogin();

    const createRes = await app.request(
      "/api/v1/account/access-tokens",
      json({ name: "second-token" }, cookie),
    );
    expect(createRes.status).toBe(200);
    const { token: rawToken } = (await createRes.json()) as { token: string };

    // Two subsequent GET requests must not contain the raw token or key field
    for (let i = 0; i < 2; i++) {
      const listRes = await app.request("/api/v1/account/access-tokens", {
        headers: { cookie },
      });
      const listText = await listRes.text();
      expect(listText).not.toContain(rawToken);
      const list = JSON.parse(listText) as Array<Record<string, unknown>>;
      expect(list[0]).not.toHaveProperty("key");
    }
  });

  it("delete removes the token from the list", async () => {
    const cookie = await installAndLogin();

    // Create
    const createRes = await app.request(
      "/api/v1/account/access-tokens",
      json({ name: "deletable-token" }, cookie),
    );
    expect(createRes.status).toBe(200);
    const { id } = (await createRes.json()) as { id: string };

    // Delete
    const delRes = await app.request(`/api/v1/account/access-tokens/${id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(delRes.status).toBe(200);

    // Token should no longer appear in the list
    const listRes = await app.request("/api/v1/account/access-tokens", {
      headers: { cookie },
    });
    const list = (await listRes.json()) as Array<{ id: string }>;
    expect(list.find((k) => k.id === id)).toBeUndefined();
  });

  it("unauthenticated create returns 401", async () => {
    await installAndLogin(); // ensure app is installed

    const res = await app.request(
      "/api/v1/account/access-tokens",
      json({ name: "sneaky-token" }),
    );
    expect(res.status).toBe(401);
  });

  it("unauthenticated list returns 401", async () => {
    await installAndLogin();

    const res = await app.request("/api/v1/account/access-tokens");
    expect(res.status).toBe(401);
  });

  it("type defaults to classic when not specified", async () => {
    const cookie = await installAndLogin();

    const createRes = await app.request(
      "/api/v1/account/access-tokens",
      json({ name: "default-type-token" }, cookie),
    );
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { type: string };
    expect(created.type).toBe("classic");
  });

  it("type: experimental is stored and returned in list metadata", async () => {
    const cookie = await installAndLogin();

    const createRes = await app.request(
      "/api/v1/account/access-tokens",
      json({ name: "exp-token", type: "experimental" }, cookie),
    );
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { id: string; type: string };
    expect(created.type).toBe("experimental");

    const listRes = await app.request("/api/v1/account/access-tokens", {
      headers: { cookie },
    });
    const list = (await listRes.json()) as Array<{ id: string; type: string }>;
    const entry = list.find((k) => k.id === created.id);
    expect(entry?.type).toBe("experimental");
  });

  it("a second user cannot delete the first user's token (plugin scopes by owner)", async () => {
    const ownerCookie = await installAndLogin();
    const orgId = await createOrg(ownerCookie);
    const user2Cookie = await addMember(ownerCookie, orgId, "user2@example.com");

    // User 1 creates a token
    const createRes = await app.request(
      "/api/v1/account/access-tokens",
      json({ name: "owner-token" }, ownerCookie),
    );
    expect(createRes.status).toBe(200);
    const { id } = (await createRes.json()) as { id: string };

    // User 2 tries to delete user 1's token — must be rejected (404 or 403)
    const delRes = await app.request(`/api/v1/account/access-tokens/${id}`, {
      method: "DELETE",
      headers: { cookie: user2Cookie },
    });
    expect(delRes.status).toBeGreaterThanOrEqual(400);

    // Token must still exist in user 1's list
    const listRes = await app.request("/api/v1/account/access-tokens", {
      headers: { cookie: ownerCookie },
    });
    const list = (await listRes.json()) as Array<{ id: string }>;
    expect(list.find((k) => k.id === id)).toBeDefined();
  });
});
