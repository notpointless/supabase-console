import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { AppError, onError } from "../src/http/error";

describe("error handler", () => {
  const app = new Hono();
  app.onError(onError);
  app.get("/boom", () => {
    throw new AppError(409, "not_installed", "Instance is not installed");
  });
  app.get("/oops", () => {
    throw new Error("kaboom");
  });

  it("renders AppError as structured JSON", async () => {
    const res = await app.request("/boom");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "not_installed", message: "Instance is not installed" },
    });
  });

  it("renders unknown errors as 500 internal_error", async () => {
    const res = await app.request("/oops");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: "internal_error", message: "Internal server error" },
    });
  });
});
