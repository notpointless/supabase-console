import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/app";
import { setMailer, resetMailer } from "../src/email/mailer";
import { permissionsToScopes } from "../src/auth/oauth-scopes";

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

/** Invite a new user to an org with any role and return their session cookie. */
async function addMember(
  ownerCookie: string,
  orgId: string,
  email: string,
  role: string,
): Promise<string> {
  let inv = "";
  setMailer({
    sendInvite: async (e) => {
      inv = new URL(e.acceptUrl).searchParams.get("invitationId") ?? "";
    },
  });
  await app.request(
    "/api/auth/organization/invite-member",
    json({ email, role, organizationId: orgId }, ownerCookie),
  );
  const r = await app.request(
    "/api/auth/invite/accept-new",
    json({ invitationId: inv, name: "Member", password: "supersecret123" }),
  );
  return r.headers.get("set-cookie") ?? "";
}

const APP_BODY = { name: "My App", redirectUrls: ["https://client.example.com/callback"] };

describe("org oauth apps", () => {
  beforeEach(() => resetMailer());

  it("owner registers an app, secret returned once; list never exposes the secret", async () => {
    const cookie = await installAndLogin();
    const orgId = await createOrg(cookie);

    // Register
    const reg = await app.request(
      `/api/v1/organizations/${orgId}/oauth-apps`,
      json(APP_BODY, cookie),
    );
    expect(reg.status).toBe(200);
    const created = (await reg.json()) as {
      clientId: string;
      clientSecret: string;
      name: string;
    };
    expect(created.clientId).toBeTruthy();
    expect(created.clientSecret).toBeTruthy();
    expect(created.name).toBe("My App");
    const secret = created.clientSecret;

    // List must contain the app but NEVER the secret
    const listRes = await app.request(`/api/v1/organizations/${orgId}/oauth-apps`, {
      headers: { cookie },
    });
    expect(listRes.status).toBe(200);
    const listText = await listRes.text();
    const list = JSON.parse(listText) as {
      apps: Array<{ clientId: string; name: string; redirectUrls: string[] }>;
    };
    expect(list.apps).toHaveLength(1);
    expect(list.apps[0]!.clientId).toBe(created.clientId);
    expect(list.apps[0]!.name).toBe("My App");
    expect(list.apps[0]!.redirectUrls).toEqual(["https://client.example.com/callback"]);
    expect(listText).not.toContain("clientSecret");
    expect(listText).not.toContain(secret);

    // A second GET also never exposes the secret
    const listRes2 = await app.request(`/api/v1/organizations/${orgId}/oauth-apps`, {
      headers: { cookie },
    });
    const listText2 = await listRes2.text();
    expect(listText2).not.toContain("clientSecret");
    expect(listText2).not.toContain(secret);
  });

  it("developer cannot register an app (403)", async () => {
    const cookie = await installAndLogin();
    const orgId = await createOrg(cookie);
    const devCookie = await addMember(cookie, orgId, "dev@example.com", "developer");

    const reg = await app.request(
      `/api/v1/organizations/${orgId}/oauth-apps`,
      json(APP_BODY, devCookie),
    );
    expect(reg.status).toBe(403);
  });

  it("developer cannot delete an app (403)", async () => {
    const cookie = await installAndLogin();
    const orgId = await createOrg(cookie);

    const reg = await app.request(
      `/api/v1/organizations/${orgId}/oauth-apps`,
      json(APP_BODY, cookie),
    );
    const { clientId } = (await reg.json()) as { clientId: string };

    const devCookie = await addMember(cookie, orgId, "dev@example.com", "developer");
    const del = await app.request(
      `/api/v1/organizations/${orgId}/oauth-apps/${clientId}`,
      { method: "DELETE", headers: { cookie: devCookie } },
    );
    expect(del.status).toBe(403);
  });

  it("owner deletes an app and it disappears from the list", async () => {
    const cookie = await installAndLogin();
    const orgId = await createOrg(cookie);

    const reg = await app.request(
      `/api/v1/organizations/${orgId}/oauth-apps`,
      json(APP_BODY, cookie),
    );
    const { clientId } = (await reg.json()) as { clientId: string };

    const del = await app.request(
      `/api/v1/organizations/${orgId}/oauth-apps/${clientId}`,
      { method: "DELETE", headers: { cookie } },
    );
    expect(del.status).toBe(200);

    const listRes = await app.request(`/api/v1/organizations/${orgId}/oauth-apps`, {
      headers: { cookie },
    });
    const list = (await listRes.json()) as { apps: unknown[] };
    expect(list.apps).toHaveLength(0);
  });

  it("administrator CAN register an app (200)", async () => {
    const ownerCookie = await installAndLogin();
    const orgId = await createOrg(ownerCookie);
    const adminCookie = await addMember(ownerCookie, orgId, "admin2@example.com", "administrator");

    const reg = await app.request(
      `/api/v1/organizations/${orgId}/oauth-apps`,
      json(APP_BODY, adminCookie),
    );
    expect(reg.status).toBe(200);
    const body = (await reg.json()) as { clientId: string; clientSecret: string };
    expect(body.clientId).toBeTruthy();
    expect(body.clientSecret).toBeTruthy();
  });

  it("validation: missing redirectUrls returns 400", async () => {
    const cookie = await installAndLogin();
    const orgId = await createOrg(cookie);

    const bad = await app.request(
      `/api/v1/organizations/${orgId}/oauth-apps`,
      json({ name: "No Redirects" }, cookie),
    );
    expect(bad.status).toBe(400);
  });

  it("unauthenticated returns 401", async () => {
    const cookie = await installAndLogin();
    const orgId = await createOrg(cookie);

    const unauth = await app.request(
      `/api/v1/organizations/${orgId}/oauth-apps`,
      json(APP_BODY),
    );
    expect(unauth.status).toBe(401);
  });

  it("authorized apps endpoint returns an empty list for a user with no consents", async () => {
    const cookie = await installAndLogin();
    const orgId = await createOrg(cookie);

    // Publish an app so the org has one, but the owner hasn't consented to it.
    await app.request(`/api/v1/organizations/${orgId}/oauth-apps`, json(APP_BODY, cookie));

    const res = await app.request(
      `/api/v1/organizations/${orgId}/oauth-apps/authorized`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { apps: unknown[] };
    expect(body.apps).toEqual([]);
  });

  it("cross-org: member of org B cannot register or list org A apps (403)", async () => {
    const ownerCookie = await installAndLogin();
    const orgAId = await createOrg(ownerCookie, "Org A");
    const orgBId = await createOrg(ownerCookie, "Org B");
    const userBCookie = await addMember(ownerCookie, orgBId, "userb@example.com", "developer");

    const getRes = await app.request(`/api/v1/organizations/${orgAId}/oauth-apps`, {
      headers: { cookie: userBCookie },
    });
    expect(getRes.status).toBe(403);

    const postRes = await app.request(
      `/api/v1/organizations/${orgAId}/oauth-apps`,
      json(APP_BODY, userBCookie),
    );
    expect(postRes.status).toBe(403);
  });

  it("registers with permissions+website+logo; GET list reflects scopes, website, logo; no secret", async () => {
    const cookie = await installAndLogin();
    const orgId = await createOrg(cookie);

    const regRes = await app.request(
      `/api/v1/organizations/${orgId}/oauth-apps`,
      json(
        {
          name: "Scoped App",
          redirectUrls: ["https://scoped.example.com/callback"],
          website: "https://scoped.example.com",
          logo: "https://scoped.example.com/logo.png",
          permissions: {
            database: "write",
            analytics: "read",
            storage: "none",
          },
        },
        cookie,
      ),
    );
    expect(regRes.status).toBe(200);
    const regBody = (await regRes.json()) as {
      clientId: string;
      clientSecret: string;
      name: string;
    };
    expect(regBody.clientId).toBeTruthy();
    expect(regBody.clientSecret).toBeTruthy();
    expect(regBody.name).toBe("Scoped App");

    // GET list — check scopes, website, logo and absence of secret
    const listRes = await app.request(`/api/v1/organizations/${orgId}/oauth-apps`, {
      headers: { cookie },
    });
    expect(listRes.status).toBe(200);
    const listText = await listRes.text();
    const list = JSON.parse(listText) as {
      apps: Array<{
        clientId: string;
        name: string;
        redirectUrls: string[];
        scopes: string[];
        website?: string;
        logo?: string;
      }>;
    };

    expect(list.apps).toHaveLength(1);
    const appEntry = list.apps[0]!;

    // Scopes: database write → read+write; analytics read → read only; storage none → omitted
    expect(appEntry.scopes).toContain("database:read");
    expect(appEntry.scopes).toContain("database:write");
    expect(appEntry.scopes).toContain("analytics:read");
    expect(appEntry.scopes).not.toContain("analytics:write");
    expect(appEntry.scopes).not.toContain("storage:read");
    expect(appEntry.scopes).not.toContain("storage:write");

    // Extra fields
    expect(appEntry.website).toBe("https://scoped.example.com");
    expect(appEntry.logo).toBe("https://scoped.example.com/logo.png");

    // Secret must never appear
    expect(listText).not.toContain("clientSecret");
    expect(listText).not.toContain(regBody.clientSecret);
  });

  it("GET /api/v1/oauth-scopes returns the catalog (12 resources)", async () => {
    const cookie = await installAndLogin();

    const res = await app.request("/api/v1/oauth-scopes", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resources: Array<{ id: string; label: string; description: string }> };

    expect(body.resources).toHaveLength(12);

    const ids = body.resources.map((r) => r.id);
    expect(ids).toContain("database");
    expect(ids).toContain("secrets");
    expect(ids).toContain("storage");
  });

  it("GET /api/v1/oauth-scopes requires authentication (401)", async () => {
    await installAndLogin(); // ensure the app is installed; then call WITHOUT the cookie
    const res = await app.request("/api/v1/oauth-scopes");
    expect(res.status).toBe(401);
  });
});

describe("permissionsToScopes unit tests", () => {
  it("write access produces both :read and :write scopes", () => {
    const result = permissionsToScopes({ database: "write" });
    expect(result).toContain("database:read");
    expect(result).toContain("database:write");
    expect(result).toHaveLength(2);
  });

  it("read access produces only :read scope", () => {
    const result = permissionsToScopes({ analytics: "read" });
    expect(result).toContain("analytics:read");
    expect(result).not.toContain("analytics:write");
    expect(result).toHaveLength(1);
  });

  it("none access is omitted from scopes", () => {
    const result = permissionsToScopes({ storage: "none" });
    expect(result).toHaveLength(0);
  });

  it("unknown resource id is silently ignored", () => {
    const result = permissionsToScopes({ unknown_resource: "write" });
    expect(result).toHaveLength(0);
  });

  it("mixed permissions produce correct scope set", () => {
    const result = permissionsToScopes({
      database: "write",
      analytics: "read",
      storage: "none",
      unknown_resource: "write",
    });
    expect(result).toContain("database:read");
    expect(result).toContain("database:write");
    expect(result).toContain("analytics:read");
    expect(result).not.toContain("analytics:write");
    expect(result).not.toContain("storage:read");
    expect(result).not.toContain("storage:write");
    expect(result).not.toContain("unknown_resource:read");
    expect(result).not.toContain("unknown_resource:write");
    expect(result).toHaveLength(3);
  });

  it("empty permissions produce empty scopes", () => {
    const result = permissionsToScopes({});
    expect(result).toHaveLength(0);
  });
});
