import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import type { ProjectSecretValues } from "../secrets";
import { STACK_ENV_DEFAULTS } from "./env-defaults";

export interface BuildStackInput {
  project: { ref: string; name: string };
  secrets: ProjectSecretValues;
  dbPassword: string;
  ports: { kongHttp: number; kongHttps: number; db: number };
  urls: { apiExternalUrl: string; siteUrl: string; supabasePublicUrl: string };
  // When false, the REST Data API does not expose the user's `public` schema.
  dataApiEnabled?: boolean;
}

const BASE_PATH = join(dirname(fileURLToPath(import.meta.url)), "compose.base.yml");

export function buildStack(input: BuildStackInput): { composeYaml: string; env: Record<string, string> } {
  const env: Record<string, string> = {
    ...STACK_ENV_DEFAULTS,
    POSTGRES_PASSWORD: input.dbPassword,
    JWT_SECRET: input.secrets.jwtSecret,
    ANON_KEY: input.secrets.anonKey,
    SERVICE_ROLE_KEY: input.secrets.serviceRoleKey,
    SECRET_KEY_BASE: input.secrets.secretKeyBase,
    DASHBOARD_PASSWORD: input.secrets.dashboardPassword,
    VAULT_ENC_KEY: input.secrets.vaultEncKey,
    PG_META_CRYPTO_KEY: input.secrets.pgMetaCryptoKey,
    KONG_HTTP_PORT: String(input.ports.kongHttp),
    KONG_HTTPS_PORT: String(input.ports.kongHttps),
    POSTGRES_PORT: String(input.ports.db),
    API_EXTERNAL_URL: input.urls.apiExternalUrl,
    SITE_URL: input.urls.siteUrl,
    SUPABASE_PUBLIC_URL: input.urls.supabasePublicUrl,
  };

  // Data API disabled: don't expose the user's `public` schema over REST.
  if (input.dataApiEnabled === false) {
    env.PGRST_DB_SCHEMAS = "graphql_public";
  }

  const doc = parse(readFileSync(BASE_PATH, "utf8")) as {
    name?: string;
    services: Record<string, Record<string, unknown>>;
    [k: string]: unknown;
  };

  doc.name = `sb-${input.project.ref}`;

  for (const svc of Object.values(doc.services)) {
    delete svc["container_name"];
  }

  return { composeYaml: stringify(doc), env };
}
