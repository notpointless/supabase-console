import { describe, it, expect, beforeEach } from "vitest";
import { auth } from "../src/auth";
import { setMailer, resetMailer, type InviteEmail } from "../src/email/mailer";

const headers = { "content-type": "application/json" };
const post = (path: string, body: unknown, cookie = "") =>
  auth.handler(
    new Request(`http://localhost:3000/api/auth${path}`, {
      method: "POST",
      headers: cookie ? { ...headers, cookie } : headers,
      body: JSON.stringify(body),
    }),
  );

async function installAndLogin(): Promise<string> {
  const res = await post("/install/setup", {
    name: "Admin",
    email: "admin@example.com",
    password: "supersecret123",
  });
  return res.headers.get("set-cookie") ?? "";
}

describe("organizations", () => {
  beforeEach(() => resetMailer());

  it("creates an org with an auto-generated slug, given type, and default privacy", async () => {
    const cookie = await installAndLogin();
    const res = await post("/organization/create", { name: "Acme", type: "startup" }, cookie);
    expect(res.status).toBe(200);
    const org = await res.json();
    expect(org.slug).toMatch(/^[a-z]{20}$/);
    expect(org.type).toBe("startup");
    expect(org.dataPrivacyLevel).toBe("disabled");
  });

  it("rejects an invalid org type on create", async () => {
    const cookie = await installAndLogin();
    const res = await post("/organization/create", { name: "Bad", type: "enterprise" }, cookie);
    expect(res.status).toBe(400);
  });

  it("updates type and dataPrivacyLevel and rejects invalid privacy", async () => {
    const cookie = await installAndLogin();
    const created = await (
      await post("/organization/create", { name: "Acme", type: "personal" }, cookie)
    ).json();
    const ok = await post(
      "/organization/update",
      { organizationId: created.id, data: { dataPrivacyLevel: "schema_and_logs" } },
      cookie,
    );
    expect(ok.status).toBe(200);
    const bad = await post(
      "/organization/update",
      { organizationId: created.id, data: { dataPrivacyLevel: "everything" } },
      cookie,
    );
    expect(bad.status).toBe(400);
  });

  it("invite-member triggers the mailer with a correct accept url", async () => {
    const sent: InviteEmail[] = [];
    setMailer({
      sendInvite: async (e) => {
        sent.push(e);
      },
    });
    const cookie = await installAndLogin();
    const org = await (
      await post("/organization/create", { name: "Acme", type: "company" }, cookie)
    ).json();
    const res = await post(
      "/organization/invite-member",
      { email: "invitee@example.com", role: "developer", organizationId: org.id },
      cookie,
    );
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("invitee@example.com");
    expect(sent[0]!.acceptUrl).toContain("/accept-invite?invitationId=");
    expect(sent[0]!.organizationName).toBe("Acme");
  });
});
