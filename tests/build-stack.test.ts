import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { buildStack } from "../src/projects/stack/compose";

const input = {
  project: { ref: "abcdefghij1234567890", name: "My Project" },
  secrets: { jwtSecret: "j".repeat(40), anonKey: "anon.jwt.token", serviceRoleKey: "service.jwt.token", secretKeyBase: "b".repeat(64), dashboardPassword: "dashpw" },
  dbPassword: "dbpw",
  ports: { kongHttp: 18000, kongHttps: 18443, db: 15432 },
  urls: { apiExternalUrl: "http://localhost:18000", siteUrl: "http://localhost:3000", supabasePublicUrl: "http://localhost:18000" },
};

describe("buildStack", () => {
  it("produces valid YAML, a per-project compose name, and no colliding container_name", () => {
    const { composeYaml } = buildStack(input);
    const doc = parse(composeYaml) as { name?: string; services: Record<string, Record<string, unknown>> };
    expect(doc.name).toBe("sb-abcdefghij1234567890");
    expect(Object.keys(doc.services).length).toBeGreaterThanOrEqual(10);
    for (const svc of Object.values(doc.services)) {
      expect(svc.container_name).toBeUndefined();
    }
  });

  it("env carries the per-project dynamic values plus static defaults", () => {
    const { env } = buildStack(input);
    expect(env.JWT_SECRET).toBe(input.secrets.jwtSecret);
    expect(env.ANON_KEY).toBe(input.secrets.anonKey);
    expect(env.SERVICE_ROLE_KEY).toBe(input.secrets.serviceRoleKey);
    expect(env.SECRET_KEY_BASE).toBe(input.secrets.secretKeyBase);
    expect(env.POSTGRES_PASSWORD).toBe(input.dbPassword);
    expect(env.DASHBOARD_PASSWORD).toBe(input.secrets.dashboardPassword);
    expect(env.KONG_HTTP_PORT).toBe("18000");
    expect(env.KONG_HTTPS_PORT).toBe("18443");
    expect(env.API_EXTERNAL_URL).toBe("http://localhost:18000");
    expect(env.SITE_URL).toBe("http://localhost:3000");
    expect(env.SUPABASE_PUBLIC_URL).toBe("http://localhost:18000");
    expect(env.POSTGRES_DB).toBe("postgres");
    expect(env.POSTGRES_PORT).toBe("15432");
  });
});
