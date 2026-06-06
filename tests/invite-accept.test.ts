import { describe, it, expect, beforeEach } from "vitest";
import { auth } from "../src/auth";
import { setMailer, resetMailer } from "../src/email/mailer";

const headers = { "content-type": "application/json" };
const post = (path: string, body: unknown, cookie = "") =>
  auth.handler(
    new Request(`http://localhost:3000/api/auth${path}`, {
      method: "POST",
      headers: cookie ? { ...headers, cookie } : headers,
      body: JSON.stringify(body),
    }),
  );

async function inviteInto(email: string): Promise<{ cookie: string; invitationId: string }> {
  let invitationId = "";
  setMailer({
    sendInvite: async (e) => {
      invitationId = new URL(e.acceptUrl).searchParams.get("invitationId") ?? "";
    },
  });
  const setup = await post("/install/setup", {
    name: "Admin",
    email: "admin@example.com",
    password: "supersecret123",
  });
  const cookie = setup.headers.get("set-cookie") ?? "";
  const org = await (await post("/organization/create", { name: "Acme", type: "company" }, cookie)).json();
  await post("/organization/invite-member", { email, role: "developer", organizationId: org.id }, cookie);
  return { cookie, invitationId };
}

describe("accept-new", () => {
  beforeEach(() => resetMailer());

  it("onboards a brand-new invitee: account + member + session", async () => {
    const { invitationId } = await inviteInto("newbie@example.com");
    expect(invitationId).toBeTruthy();
    const res = await post("/invite/accept-new", {
      invitationId,
      name: "Newbie",
      password: "supersecret123",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeTruthy();
    const body = await res.json();
    expect(body.user.email).toBe("newbie@example.com");
    expect(body.organizationId).toBeTruthy();

    const login = await post("/sign-in/email", {
      email: "newbie@example.com",
      password: "supersecret123",
    });
    expect(login.status).toBe(200);
  });

  it("rejects re-accepting the same invitation", async () => {
    const { invitationId } = await inviteInto("once@example.com");
    await post("/invite/accept-new", { invitationId, name: "Once", password: "supersecret123" });
    const again = await post("/invite/accept-new", {
      invitationId,
      name: "Twice",
      password: "supersecret123",
    });
    expect(again.status).toBe(400);
  });

  it("rejects accept-new when an account already exists for the email", async () => {
    // First onboard a brand-new invitee so an account exists for the email.
    const { cookie, invitationId } = await inviteInto("dup@example.com");
    await post("/invite/accept-new", { invitationId, name: "Dup", password: "supersecret123" });

    // Now invite that (already-existing) user into a SECOND org, where they are not
    // yet a member, so a real pending invitation is created. better-auth blocks
    // inviting an existing member, so we cannot reuse the first org here.
    let secondInvitationId = "";
    setMailer({
      sendInvite: async (e) => {
        secondInvitationId = new URL(e.acceptUrl).searchParams.get("invitationId") ?? "";
      },
    });
    const beta = await (
      await post("/organization/create", { name: "Beta", type: "company" }, cookie)
    ).json();
    await post(
      "/organization/invite-member",
      { email: "dup@example.com", role: "developer", organizationId: beta.id },
      cookie,
    );
    expect(secondInvitationId).toBeTruthy();

    // accept-new must reject because an account already exists for this email.
    const res = await post("/invite/accept-new", {
      invitationId: secondInvitationId,
      name: "Dup Again",
      password: "supersecret123",
    });
    expect(res.status).toBe(409);
  });
});
