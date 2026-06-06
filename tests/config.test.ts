import { describe, it, expect } from "vitest";
import { parseEnv } from "../src/config/env";

describe("parseEnv", () => {
  it("parses a valid environment", () => {
    const env = parseEnv({
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      BETTER_AUTH_SECRET: "x".repeat(32),
      BETTER_AUTH_URL: "http://localhost:3000",
    });
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("throws when a required var is missing", () => {
    expect(() => parseEnv({ BETTER_AUTH_SECRET: "x".repeat(32) })).toThrow(/DATABASE_URL/);
  });
});
