import { describe, it, expect } from "vitest";
import { parseEnv } from "../src/config/env";

describe("parseEnv", () => {
  it("parses a valid environment", () => {
    const env = parseEnv({
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      BETTER_AUTH_SECRET: "x".repeat(32),
      BETTER_AUTH_URL: "http://localhost:3000",
      ENCRYPTION_KEY: "a".repeat(64),
    });
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("throws when a required var is missing", () => {
    expect(() => parseEnv({ BETTER_AUTH_SECRET: "x".repeat(32) })).toThrow(/DATABASE_URL/);
  });

  it("accepts optional email vars and tolerates their absence", () => {
    const withMail = parseEnv({
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      BETTER_AUTH_SECRET: "x".repeat(32),
      BETTER_AUTH_URL: "http://localhost:3000",
      ENCRYPTION_KEY: "a".repeat(64),
      SMTP_URL: "smtp://user:pass@localhost:1025",
      MAIL_FROM: "Console <no-reply@example.com>",
      APP_URL: "http://localhost:3000",
    });
    expect(withMail.SMTP_URL).toBe("smtp://user:pass@localhost:1025");
    expect(withMail.APP_URL).toBe("http://localhost:3000");

    const without = parseEnv({
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      BETTER_AUTH_SECRET: "x".repeat(32),
      BETTER_AUTH_URL: "http://localhost:3000",
      ENCRYPTION_KEY: "a".repeat(64),
    });
    expect(without.SMTP_URL).toBeUndefined();
    expect(without.MAIL_FROM).toBeUndefined();
  });
});
