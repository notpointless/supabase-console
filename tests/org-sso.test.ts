import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/app";
import { setMailer, resetMailer } from "../src/email/mailer";

/**
 * Minimal SAML config accepted by @better-auth/sso at registration time.
 * - entryPoint must be a valid URL (plugin validates this)
 * - cert is stored as-is; X509 parsing only happens at sign-in time
 * - callbackUrl is stored as-is; not validated at registration
 * - spMetadata is required by the plugin schema (though all its sub-fields are optional)
 *
 * We intentionally use a fake cert to confirm the plugin does NOT validate it at registration,
 * and that our list endpoint never returns it.
 */
const SAML = {
  entryPoint: "https://idp.example.com/sso",
  cert: "MIIC_FAKE_CERT_NOT_REAL_DO_NOT_USE",
  callbackUrl: "http://localhost:3000/api/auth/sso/saml2/sp/acs/acme",
  spMetadata: {},
};

const json = (body: unknown, cookie = "") => {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (cookie) h.cookie = cookie;
  return { method: "POST", headers: h, body: JSON.stringify(body) } as RequestInit;
};

async function installAndLogin(): Promise<string> {
  const r = await app.request("/api/auth/install/setup", json({ name: "Admin", email: "admin@example.com", password: "supersecret123" }));
  return r.headers.get("set-cookie") ?? "";
}

async function createOrg(cookie: string, name = "Acme"): Promise<string> {
  const r = await app.request("/api/auth/organization/create", json({ name, type: "company" }, cookie));
  return ((await r.json()) as { id: string }).id;
}

async function addDeveloper(ownerCookie: string, orgId: string, email: string): Promise<string> {
  let inv = "";
  setMailer({
    sendInvite: async (e) => {
      inv = new URL(e.acceptUrl).searchParams.get("invitationId") ?? "";
    },
  });
  await app.request("/api/auth/organization/invite-member", json({ email, role: "developer", organizationId: orgId }, ownerCookie));
  const r = await app.request("/api/auth/invite/accept-new", json({ invitationId: inv, name: "Dev", password: "supersecret123" }));
  return r.headers.get("set-cookie") ?? "";
}

describe("org sso", () => {
  beforeEach(() => resetMailer());

  it("owner registers a SAML provider; list returns it without secrets", async () => {
    const cookie = await installAndLogin();
    const orgId = await createOrg(cookie);

    // Register
    const reg = await app.request(
      `/api/v1/organizations/${orgId}/sso`,
      json({ providerId: "acme", issuer: "https://idp.example.com", domain: "acme.com", samlConfig: SAML }, cookie),
    );
    expect(reg.status).toBe(200);
    const registered = (await reg.json()) as Record<string, unknown>;
    expect(registered.providerId).toBe("acme");
    expect(registered.domain).toBe("acme.com");
    // Registration response must NOT expose secrets
    expect(JSON.stringify(registered)).not.toContain("FAKE_CERT");
    expect(JSON.stringify(registered)).not.toContain("BEGIN CERTIFICATE");

    // List
    const listRes = await app.request(`/api/v1/organizations/${orgId}/sso`, {
      headers: { cookie },
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { providers: Array<Record<string, unknown>> };
    expect(list.providers).toHaveLength(1);
    const p = list.providers[0]!;
    expect(p.domain).toBe("acme.com");
    expect(p.providerId).toBe("acme");
    // Must never leak the cert or any SAML/OIDC secret fields
    expect(JSON.stringify(list)).not.toContain("BEGIN CERTIFICATE");
    expect(JSON.stringify(list)).not.toContain("FAKE_CERT");
    expect(JSON.stringify(list)).not.toContain("samlConfig");
    expect(JSON.stringify(list)).not.toContain("oidcConfig");
  });

  it("developer cannot register an SSO provider (403)", async () => {
    const cookie = await installAndLogin();
    const orgId = await createOrg(cookie);
    const devCookie = await addDeveloper(cookie, orgId, "dev@example.com");

    const reg = await app.request(
      `/api/v1/organizations/${orgId}/sso`,
      json({ providerId: "x", issuer: "https://idp.example.com", domain: "dev.com", samlConfig: SAML }, devCookie),
    );
    expect(reg.status).toBe(403);
  });

  it("missing samlConfig AND oidcConfig returns 400; unauthenticated returns 401", async () => {
    const cookie = await installAndLogin();
    const orgId = await createOrg(cookie);

    // 400: missing config
    const bad = await app.request(
      `/api/v1/organizations/${orgId}/sso`,
      json({ providerId: "x", issuer: "https://idp.example.com", domain: "d.com" }, cookie),
    );
    expect(bad.status).toBe(400);

    // 401: no cookie (unauthenticated)
    const unauth = await app.request(
      `/api/v1/organizations/${orgId}/sso`,
      json({ providerId: "x", issuer: "https://idp.example.com", domain: "d.com", samlConfig: SAML }),
    );
    expect(unauth.status).toBe(401);
  });

  it("owner deletes a provider and it disappears from the list", async () => {
    const cookie = await installAndLogin();
    const orgId = await createOrg(cookie);

    // Register first
    await app.request(
      `/api/v1/organizations/${orgId}/sso`,
      json({ providerId: "acme", issuer: "https://idp.example.com", domain: "acme.com", samlConfig: SAML }, cookie),
    );

    // Delete
    const del = await app.request(`/api/v1/organizations/${orgId}/sso/acme`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(del.status).toBe(200);

    // List should now be empty
    const listRes = await app.request(`/api/v1/organizations/${orgId}/sso`, {
      headers: { cookie },
    });
    const list = (await listRes.json()) as { providers: unknown[] };
    expect(list.providers).toHaveLength(0);
  });
});
