import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import type { ProjectSecretValues } from "../secrets";
import { derivePublishableKey, deriveSecretKey, deriveSigningKeys } from "../secrets";
import { readStandbyKeys } from "../signing-keys-store";
import { STACK_ENV_DEFAULTS } from "./env-defaults";

export interface BuildStackInput {
  project: { ref: string; name: string };
  secrets: ProjectSecretValues;
  dbPassword: string;
  ports: { kongHttp: number; kongHttps: number; db: number };
  urls: { apiExternalUrl: string; siteUrl: string; supabasePublicUrl: string };
  // When false, the REST Data API does not expose the user's `public` schema.
  dataApiEnabled?: boolean;
  // [console fork] Per-project GoTrue auth-config overrides (the Authentication settings
  // pages). Applied as bare env vars the compose maps to GOTRUE_* (e.g. OAUTH_SERVER_ENABLED
  // → GOTRUE_OAUTH_SERVER_ENABLED). Infra-critical keys are never overridable (denylist below).
  authConfig?: Record<string, unknown> | null;
  // [console fork] Third-Party Auth issuer JWKS keys to add to the stack's verify set, so the
  // data API accepts tokens signed by configured external issuers (Firebase, Auth0, etc.).
  thirdPartyJwks?: unknown[];
  // [console fork] Storage settings overrides (the Storage settings page). Currently the upload
  // file-size limit in bytes → the storage container's FILE_SIZE_LIMIT.
  storageConfig?: { fileSizeLimit?: number } | null;
}

// [console fork] An auth-config override may only set RECOGNISED GoTrue settings — an
// allowlist, never a denylist. A project member edits these via the auth-config endpoint,
// so anything unrecognised must be ignored: otherwise a hostile payload could set an infra
// var the compose interpolates (e.g. POSTGRES_HOST → GOTRUE_DB_DATABASE_URL) and redirect
// GoTrue's DB connection — leaking the real password — or clobber ports/keys. A denylist
// can't enumerate every sensitive var; an allowlist is closed by construction.
const AUTH_CONFIG_EXACT_KEYS = new Set([
  "SITE_URL", "URI_ALLOW_LIST", "ADDITIONAL_REDIRECT_URLS", "DISABLE_SIGNUP", "JWT_EXP",
  "OAUTH_SERVER_ENABLED", "OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION",
]);
// Families of GoTrue auth settings (GOTRUE_<KEY>); none collide with infra env.
const AUTH_CONFIG_KEY_PREFIXES = [
  "SECURITY_", "SESSIONS_", "PASSWORD_", "RATE_LIMIT_", "REFRESH_TOKEN_",
  "MAILER_", "SMTP_", "SMS_", "MFA_", "HOOK_", "EXTERNAL_",
];
function isAuthConfigKey(key: string): boolean {
  return AUTH_CONFIG_EXACT_KEYS.has(key) || AUTH_CONFIG_KEY_PREFIXES.some((p) => key.startsWith(p));
}

const BASE_PATH = join(dirname(fileURLToPath(import.meta.url)), "compose.base.yml");

export async function buildStack(
  input: BuildStackInput
): Promise<{ composeYaml: string; env: Record<string, string> }> {
  // Asymmetric (ES256) JWT signing keys. The JWKS also carries the legacy HS256 key,
  // so every service validates BOTH old symmetric tokens and the new asymmetric ones —
  // enabling signing keys without breaking anything.
  const signing = await deriveSigningKeys(input.secrets.jwtSecret);
  // Merge any operator-created standby signing keys so the stack verifies tokens they
  // sign (in the JWKS) and GoTrue knows about them (GOTRUE_JWT_KEYS).
  const standby = readStandbyKeys(input.project.ref);
  const jwtJwksObj = JSON.parse(signing.jwtJwks) as { keys: any[] };
  // [console fork] GoTrue verifies ONLY against GOTRUE_JWT_KEYS, so that key set must ALSO
  // carry the legacy HS256 verify key — otherwise the standard anon/service_role (HS256)
  // tokens are rejected with "signing method HS256 is invalid", breaking every project-internal
  // admin call. deriveSigningKeys already builds it into the JWKS; lift it into the keys array.
  const legacyHs256 = jwtJwksObj.keys.find((k: any) => k?.kty === "oct");
  const jwtKeysArr = [
    ...JSON.parse(signing.jwtKeys),
    ...(legacyHs256 ? [legacyHs256] : []),
    ...standby.map((k) => k.privateJwk),
  ];
  jwtJwksObj.keys.push(...standby.map((k) => k.publicJwk));
  // [console fork] Trust configured third-party issuers' keys (verify-only — never added to
  // the signing set) so the data API accepts tokens those external IdPs sign.
  if (Array.isArray(input.thirdPartyJwks) && input.thirdPartyJwks.length > 0) {
    jwtJwksObj.keys.push(...(input.thirdPartyJwks as any[]));
  }
  const env: Record<string, string> = {
    ...STACK_ENV_DEFAULTS,
    POSTGRES_PASSWORD: input.dbPassword,
    JWT_SECRET: input.secrets.jwtSecret,
    ANON_KEY: input.secrets.anonKey,
    SERVICE_ROLE_KEY: input.secrets.serviceRoleKey,
    // New-format API keys; kong accepts these as anon/service_role keyauth creds.
    SUPABASE_PUBLISHABLE_KEY: derivePublishableKey(input.secrets.jwtSecret),
    SUPABASE_SECRET_KEY: deriveSecretKey(input.secrets.jwtSecret),
    // Kong's request-transformer swaps an incoming sb_ opaque key for these
    // ES256-signed JWTs (validated everywhere via the JWKS below).
    ANON_KEY_ASYMMETRIC: signing.anonAsymmetric,
    SERVICE_ROLE_KEY_ASYMMETRIC: signing.serviceAsymmetric,
    // GoTrue signs new tokens with these; all services verify via the JWKS.
    JWT_KEYS: JSON.stringify(jwtKeysArr),
    JWT_JWKS: JSON.stringify(jwtJwksObj),
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
    // [console fork] Logflare (analytics) — a Postgres-backed log store; the vector service ships
    // container logs into it and the dashboard's report/log graphs query it. Tokens are derived
    // from the project's JWT secret so they're stable across (re)provision.
    LOGFLARE_PUBLIC_ACCESS_TOKEN: createHmac("sha256", input.secrets.jwtSecret)
      .update("logflare_public_v1")
      .digest("hex"),
    LOGFLARE_PRIVATE_ACCESS_TOKEN: createHmac("sha256", input.secrets.jwtSecret)
      .update("logflare_private_v1")
      .digest("hex"),
    DOCKER_SOCKET_LOCATION: "/var/run/docker.sock",
    // S3-protocol credentials for the storage service's S3-compatible endpoint. The upstream
    // .env.example ships fixed, publicly-known values — leaving those in place would let anyone
    // access any project's storage over /storage/v1/s3. Derive per-project instead.
    S3_PROTOCOL_ACCESS_KEY_ID: createHmac("sha256", input.secrets.jwtSecret)
      .update("s3_protocol_key_id_v1")
      .digest("hex")
      .slice(0, 32),
    S3_PROTOCOL_ACCESS_KEY_SECRET: createHmac("sha256", input.secrets.jwtSecret)
      .update("s3_protocol_key_secret_v1")
      .digest("hex"),
  };

  // Data API disabled: don't expose the user's `public` schema over REST.
  if (input.dataApiEnabled === false) {
    env.PGRST_DB_SCHEMAS = "graphql_public";
  }

  // [console fork] Storage upload size limit (the Storage settings page) → the storage container.
  const fileSizeLimit = input.storageConfig?.fileSizeLimit;
  if (typeof fileSizeLimit === "number" && fileSizeLimit > 0) {
    env.FILE_SIZE_LIMIT = String(Math.floor(fileSizeLimit));
  }

  // [console fork] Layer the project's saved auth-config overrides on top, so the
  // Authentication settings pages (signups, OAuth providers, the OAuth server, etc.)
  // actually drive GoTrue. Bare keys map to GOTRUE_* in compose.base.yml. Only recognised
  // GoTrue settings are applied (allowlist) so this surface can never reach infra env.
  for (const [k, v] of Object.entries(input.authConfig ?? {})) {
    if (!isAuthConfigKey(k) || v === null || v === undefined) continue;
    env[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
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
