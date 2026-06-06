import { describe, it, expect } from "vitest";
import { jwtVerify } from "jose";
import { generateProjectSecrets, signSupabaseKey } from "../src/projects/secrets";

describe("project secrets generation", () => {
  it("signs a verifiable Supabase-style HS256 key with the right claims", async () => {
    const secret = "x".repeat(40);
    const token = await signSupabaseKey(secret, "anon");
    const { payload, protectedHeader } = await jwtVerify(token, new TextEncoder().encode(secret));
    expect(protectedHeader.alg).toBe("HS256");
    expect(payload.role).toBe("anon");
    expect(payload.iss).toBe("supabase");
    expect(payload.exp! - payload.iat!).toBeGreaterThan(60 * 60 * 24 * 365 * 5);
  });

  it("generates a complete, distinct secret set whose keys verify", async () => {
    const a = await generateProjectSecrets();
    const b = await generateProjectSecrets();
    expect(a.jwtSecret).not.toBe(b.jwtSecret);
    expect(a.jwtSecret.length).toBeGreaterThanOrEqual(32);
    expect(a.secretKeyBase).toMatch(/^[0-9a-f]{64}$/);
    expect(a.dashboardPassword.length).toBeGreaterThan(8);
    const anon = await jwtVerify(a.anonKey, new TextEncoder().encode(a.jwtSecret));
    const svc = await jwtVerify(a.serviceRoleKey, new TextEncoder().encode(a.jwtSecret));
    expect(anon.payload.role).toBe("anon");
    expect(svc.payload.role).toBe("service_role");
  });
});
