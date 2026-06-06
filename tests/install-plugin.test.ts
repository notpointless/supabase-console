import { describe, it, expect } from "vitest";
import { auth } from "../src/auth";

const headers = { "content-type": "application/json" };
const post = (path: string, body: unknown) =>
  auth.handler(new Request(`http://localhost:3000/api/auth${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }));
const get = (path: string) =>
  auth.handler(new Request(`http://localhost:3000/api/auth${path}`));

describe("console plugin", () => {
  it("reports not installed, then installed after setup", async () => {
    expect(await (await get("/install/status")).json()).toEqual({ installed: false });

    const res = await post("/install/setup", {
      name: "Admin",
      email: "admin@example.com",
      password: "supersecret123",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeTruthy();

    expect(await (await get("/install/status")).json()).toEqual({ installed: true });
  });

  it("rejects a second setup with 409", async () => {
    await post("/install/setup", { name: "A", email: "a@example.com", password: "supersecret123" });
    const res = await post("/install/setup", { name: "B", email: "b@example.com", password: "supersecret123" });
    expect(res.status).toBe(409);
  });

  it("blocks public sign-up", async () => {
    const res = await post("/sign-up/email", { name: "X", email: "x@example.com", password: "supersecret123" });
    expect(res.status).toBe(403);
  });

  it("allows the created admin to sign in", async () => {
    await post("/install/setup", { name: "Admin", email: "admin@example.com", password: "supersecret123" });
    const res = await post("/sign-in/email", { email: "admin@example.com", password: "supersecret123" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeTruthy();
  });
});
