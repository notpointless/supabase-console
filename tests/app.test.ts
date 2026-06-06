import { describe, it, expect } from "vitest";
import { app } from "../src/app";

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("app", () => {
  it("GET /healthz is always 200", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("gates /api/v1/me to 409 before install", async () => {
    const me = await app.request("/api/v1/me");
    expect(me.status).toBe(409);
    expect((await me.json()).error.code).toBe("not_installed");
  });

  it("install status + setup work through the mounted auth handler", async () => {
    expect(await (await app.request("/api/auth/install/status")).json()).toEqual({ installed: false });
    const setup = await app.request(
      "/api/auth/install/setup",
      json({ name: "Admin", email: "admin@example.com", password: "supersecret123" }),
    );
    expect(setup.status).toBe(200);
    expect(await (await app.request("/api/auth/install/status")).json()).toEqual({ installed: true });
  });

  it("logs in and returns the user from /api/v1/me after install", async () => {
    await app.request(
      "/api/auth/install/setup",
      json({ name: "Admin", email: "admin@example.com", password: "supersecret123" }),
    );
    const login = await app.request(
      "/api/auth/sign-in/email",
      json({ email: "admin@example.com", password: "supersecret123" }),
    );
    const cookie = login.headers.get("set-cookie") ?? "";
    const me = await app.request("/api/v1/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    expect((await me.json()).user.email).toBe("admin@example.com");
  });
});
