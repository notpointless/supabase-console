import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import type { ProjectSecretValues } from "../secrets";
import { derivePublishableKey, deriveSecretKey } from "../secrets";
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
    // New-format API keys; kong accepts these as anon/service_role keyauth creds.
    SUPABASE_PUBLISHABLE_KEY: derivePublishableKey(input.secrets.jwtSecret),
    SUPABASE_SECRET_KEY: deriveSecretKey(input.secrets.jwtSecret),
    // Kong's request-transformer swaps an incoming sb_ opaque key for these JWTs.
    // We use the working HS256 anon/service_role JWTs so every project service
    // (rest, storage, realtime, functions…) validates them, not just PostgREST.
    ANON_KEY_ASYMMETRIC: input.secrets.anonKey,
    SERVICE_ROLE_KEY_ASYMMETRIC: input.secrets.serviceRoleKey,
    SECRET_KEY_BASE: input.secrets.secretKeyBase,
    DASHBOARD_PASSWORD: input.secrets.dashboardPassword,
    VAULT_ENC_KEY: input.secrets.vaultEncKey,
    PG_META_CRYPTO_KEY: input.secrets.pgMetaCryptoKey,
    KONG_HTTP_PORT: String(input.ports.kongHttp),
    KONG_HTTPS_PORT: String(input.ports.kongHttps),
    POSTGRES_PORT: String(input.ports.db),
    // Per-project Supavisor transaction pooler host port (reserved as db+1) so
    // multiple projects don't all collide on the hardcoded 6543.
    POOLER_PROXY_PORT_TRANSACTION: String(input.ports.db + 1),
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
