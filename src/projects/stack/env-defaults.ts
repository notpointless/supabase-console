// Static defaults copied from supabase/supabase docker/.env.example @ 2026-06-06.
// Dynamic per-project values are layered on top in buildStack().
export const STACK_ENV_DEFAULTS: Record<string, string> = {
  // Asymmetric / opaque key placeholders (empty by default)
  SUPABASE_PUBLISHABLE_KEY: "",
  SUPABASE_SECRET_KEY: "",
  JWT_KEYS: "",
  JWT_JWKS: "",

  // Dashboard
  DASHBOARD_USERNAME: "supabase",

  // VAULT_ENC_KEY and PG_META_CRYPTO_KEY are intentionally absent here —
  // they are set per-project in buildStack() from project secrets (randomBytes(16).toString("hex")).

  // Analytics / Logflare tokens (operator must override).
  // NOTE: analytics (Logflare) and vector services are not included in the current vendored
  // Logflare + S3-protocol credentials are NOT defaulted here — the upstream example values are
  // publicly known, so compose.ts derives per-project values from the project's JWT secret.

  // Database
  POSTGRES_HOST: "db",
  POSTGRES_DB: "postgres",

  // Supavisor / pooler
  POOLER_PROXY_PORT_TRANSACTION: "6543",
  POOLER_DEFAULT_POOL_SIZE: "20",
  POOLER_MAX_CLIENT_CONN: "100",
  POOLER_TENANT_ID: "your-tenant-id",
  POOLER_DB_POOL_SIZE: "5",

  // Studio
  STUDIO_DEFAULT_ORGANIZATION: "Default Organization",
  STUDIO_DEFAULT_PROJECT: "Default Project",
  OPENAI_API_KEY: "sk-proj-xxxxxxxx",

  // Auth — general
  ADDITIONAL_REDIRECT_URLS: "",
  JWT_EXPIRY: "3600",
  DISABLE_SIGNUP: "false",

  // Auth — mailer paths
  MAILER_URLPATHS_CONFIRMATION: "/auth/v1/verify",
  MAILER_URLPATHS_INVITE: "/auth/v1/verify",
  MAILER_URLPATHS_RECOVERY: "/auth/v1/verify",
  MAILER_URLPATHS_EMAIL_CHANGE: "/auth/v1/verify",

  // Auth — email
  ENABLE_EMAIL_SIGNUP: "true",
  ENABLE_EMAIL_AUTOCONFIRM: "false",
  SMTP_ADMIN_EMAIL: "admin@example.com",
  SMTP_HOST: "supabase-mail",
  SMTP_PORT: "2500",
  SMTP_USER: "fake_mail_user",
  SMTP_PASS: "fake_mail_password",
  SMTP_SENDER_NAME: "fake_sender",
  ENABLE_ANONYMOUS_USERS: "false",

  // Auth — phone
  ENABLE_PHONE_SIGNUP: "true",
  ENABLE_PHONE_AUTOCONFIRM: "true",

  // Storage
  GLOBAL_S3_BUCKET: "stub",
  REGION: "stub",
  MINIO_ROOT_USER: "supa-storage",
  MINIO_ROOT_PASSWORD: "secret1234",
  STORAGE_TENANT_ID: "stub",

  // Edge functions
  FUNCTIONS_VERIFY_JWT: "false",

  // PostgREST / API
  PGRST_DB_SCHEMAS: "public,storage,graphql_public",
  PGRST_DB_MAX_ROWS: "1000",
  PGRST_DB_EXTRA_SEARCH_PATH: "public",

  // Logs / Vector
  DOCKER_SOCKET_LOCATION: "/var/run/docker.sock",

  // Analytics (Google)
  GOOGLE_PROJECT_ID: "GOOGLE_PROJECT_ID",
  GOOGLE_PROJECT_NUMBER: "GOOGLE_PROJECT_NUMBER",

  // API gateway — asymmetric pre-signed keys (empty by default)
  ANON_KEY_ASYMMETRIC: "",
  SERVICE_ROLE_KEY_ASYMMETRIC: "",

  // imgproxy
  IMGPROXY_AUTO_WEBP: "true",

  // TLS proxy (optional)
  PROXY_DOMAIN: "your-domain.example.com",
  CERTBOT_EMAIL: "admin@example.com",
};
