import { pgTable, uuid, text, boolean, jsonb, timestamp, integer, unique, index, type AnyPgColumn } from "drizzle-orm/pg-core";
import { organization, user } from "./auth-schema";

// All better-auth tables are generated into auth-schema.ts.
export * from "./auth-schema";

export const project = pgTable("project", {
  id: uuid("id").defaultRandom().primaryKey(),
  ref: text("ref").notNull().unique(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  region: text("region").notNull(),
  infrastructureType: text("infrastructure_type").notNull(), // shared | dedicated_ec2
  computeSize: text("compute_size").notNull().default("medium"), // dedicated tier -> EC2 instance type
  postgresType: text("postgres_type").notNull().default("postgres"), // postgres | orioledb
  status: text("status").notNull().default("provisioning"), // provisioning|active|paused|removing|failed
  dataApiEnabled: boolean("data_api_enabled").notNull().default(true),
  autoExposeNewTables: boolean("auto_expose_new_tables").notNull().default(true),
  autoEnableRls: boolean("auto_enable_rls").notNull().default(true),
  dbPasswordEncrypted: text("db_password_encrypted").notNull(),
  connection: jsonb("connection"),
  // Custom hostname (dedicated/EC2 only): { hostname, status, sslStatus, originIp, createdAt }.
  customHostname: jsonb("custom_hostname"),
  // [console fork] Per-project GoTrue auth-config overrides (the Authentication settings
  // pages — signups, OAuth providers, OAuth server, etc.). Applied as GOTRUE_<key> env on
  // (re)configure; null = stack defaults.
  authConfig: jsonb("auth_config"),
  // [console fork] Third-Party Auth integrations (external JWT issuers — Firebase, Auth0,
  // Cognito, etc.). Array of { id, type, oidc_issuer_url, jwks_url, custom_jwks, inserted_at,
  // resolved_jwks }. The resolved issuer JWKS is merged into the stack's verify keys so the
  // data API accepts those tokens. null/[] = none.
  thirdPartyAuth: jsonb("third_party_auth"),
  // [console fork] AWS PrivateLink endpoint-service metadata (dedicated/EC2 only):
  // { serviceId, serviceName, nlbArn, targetGroupArns, status }. Provisioned lazily when the
  // first account is allowlisted; null = not provisioned.
  privatelink: jsonb("privatelink"),
  // [console fork] Storage settings overrides (file size limit + feature toggles). fileSizeLimit
  // is applied to the storage container (FILE_SIZE_LIMIT) on (re)configure; null = stack default.
  storageConfig: jsonb("storage_config"),
  kongHttpPort: integer("kong_http_port"),
  kongHttpsPort: integer("kong_https_port"),
  dbPort: integer("db_port"),
  failureReason: text("failure_reason"),
  // Preview branches: a branch is a child project (own stack/secrets/ports) whose
  // database is seeded from the parent. `parentProjectId` is null for normal
  // (production / "main" branch) projects and set for preview branches.
  parentProjectId: uuid("parent_project_id").references((): AnyPgColumn => project.id, { onDelete: "cascade" }),
  gitBranch: text("git_branch"),
  createdBy: text("created_by")
    .notNull()
    .references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orgAwsCredentials = pgTable("org_aws_credentials", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .unique()
    .references(() => organization.id, { onDelete: "cascade" }),
  accessKeyId: text("access_key_id").notNull(),
  secretAccessKeyEncrypted: text("secret_access_key_encrypted").notNull(),
  defaultRegion: text("default_region").notNull(),
  awsAccountId: text("aws_account_id"),
  validatedAt: timestamp("validated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projectSecrets = pgTable("project_secrets", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .unique()
    .references(() => project.id, { onDelete: "cascade" }),
  jwtSecretEncrypted: text("jwt_secret_encrypted").notNull(),
  anonKeyEncrypted: text("anon_key_encrypted").notNull(),
  serviceRoleKeyEncrypted: text("service_role_key_encrypted").notNull(),
  secretKeyBaseEncrypted: text("secret_key_base_encrypted").notNull(),
  dashboardPasswordEncrypted: text("dashboard_password_encrypted").notNull(),
  vaultEncKeyEncrypted: text("vault_enc_key_encrypted").notNull(),
  pgMetaCryptoKeyEncrypted: text("pg_meta_crypto_key_encrypted").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Scopes a plugin-generated `oauthApplication` (which has no organizationId)
// to the org that published it. One row per published OAuth app.
export const orgOauthApp = pgTable("org_oauth_app", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orgGithubConnection = pgTable("org_github_connection", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull().unique().references(() => organization.id, { onDelete: "cascade" }),
  githubLogin: text("github_login").notNull(),
  accessTokenEncrypted: text("access_token_encrypted").notNull(),
  installationId: text("installation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
// Per-org GitHub App credentials. Each organization registers its OWN GitHub App
// (name + client id + secret); the connect flow + token exchange use the org's App.
export const orgGithubAppConfig = pgTable("org_github_app_config", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull().unique().references(() => organization.id, { onDelete: "cascade" }),
  appName: text("app_name").notNull(), // the App slug (used in the install URL)
  clientId: text("client_id").notNull(),
  clientSecretEncrypted: text("client_secret_encrypted").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// [console fork] Per-org AI assistant config: the organization's own OpenAI API key (encrypted
// at rest). The studio AI routes resolve this for the request's org so the Assistant runs on the
// org's own OpenAI account instead of a single global env key. The raw key is never returned to
// the browser — only a "configured" flag — and is decrypted server-side only for the AI routes.
export const orgAiConfig = pgTable("org_ai_config", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull().unique().references(() => organization.id, { onDelete: "cascade" }),
  openaiApiKeyEncrypted: text("openai_api_key_encrypted").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// A user's GitHub App OAuth authorization (user-access token + identity), scoped to
// the org whose App they authorized. Powers the "Connect GitHub" state + repo listing.
export const githubAuthorization = pgTable("github_authorization", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  githubUserId: integer("github_user_id").notNull(),
  githubLogin: text("github_login").notNull(),
  accessTokenEncrypted: text("access_token_encrypted").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("github_authorization_user_org_uniq").on(t.userId, t.organizationId)]);

// A GitHub repo <-> project connection created via the dashboard integration UI.
// Mirrors what Supabase's platform stores; kept in sync with project_repo_connection
// (repoFullName + branch) so the deploy / webhook / branch-sync pipeline can use it.
export const githubConnection = pgTable("github_connection", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").notNull().references(() => project.id, { onDelete: "cascade" }),
  installationId: integer("installation_id").notNull(),
  repositoryId: integer("repository_id").notNull(),
  repositoryName: text("repository_name").notNull(), // full name: owner/repo
  branch: text("branch").notNull().default("main"),
  workdir: text("workdir").notNull().default("."),
  newBranchPerPr: boolean("new_branch_per_pr").notNull().default(true),
  supabaseChangesOnly: boolean("supabase_changes_only").notNull().default(true),
  branchLimit: integer("branch_limit").notNull().default(3),
  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("github_connection_project_uniq").on(t.projectId)]);

// User-defined Edge Function secrets (per project). Written to the functions
// volume's .secrets.json and merged into each function's env by the main router.
export const projectFunctionSecret = pgTable("project_function_secret", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => project.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  valueEncrypted: text("value_encrypted").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("project_function_secret_name_uniq").on(t.projectId, t.name)]);

// Audit-log drains: stream the org's audit events to an external sink (webhook).
export const auditLogDrain = pgTable("audit_log_drain", {
  id: uuid("id").defaultRandom().primaryKey(), // also the public "token"
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  type: text("type").notNull().default("webhook"),
  config: jsonb("config").notNull().$type<Record<string, unknown>>(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orgVercelConnection = pgTable("org_vercel_connection", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull().unique().references(() => organization.id, { onDelete: "cascade" }),
  vercelTeam: text("vercel_team").notNull(),
  accessTokenEncrypted: text("access_token_encrypted").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const projectRepoConnection = pgTable("project_repo_connection", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => project.id, { onDelete: "cascade" }),
  repoFullName: text("repo_full_name").notNull(),
  branch: text("branch"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// AWS PrivateLink: per-project list of allowed AWS account IDs. Adding the
// first account provisions the VPC endpoint service (privatelink-service.ts);
// each row is allowlisted as a principal. status: pending -> active once the
// principal is registered on the endpoint service.
// ---------------------------------------------------------------------------
export const projectPrivatelinkAccount = pgTable(
  "project_privatelink_account",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    awsAccountId: text("aws_account_id").notNull(),
    status: text("status").notNull().default("pending"), // pending | active
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("project_privatelink_account_project_id_aws_account_id_uniq").on(t.projectId, t.awsAccountId)],
);

// ---------------------------------------------------------------------------
// Audit log: records every /api/v1 mutation (POST/PUT/PATCH/DELETE).
// Recording is best-effort — errors are swallowed in middleware.
// ---------------------------------------------------------------------------
export const auditLog = pgTable("audit_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
  organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
  method: text("method").notNull(),
  path: text("path").notNull(),
  statusCode: integer("status_code").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("audit_log_org_idx").on(t.organizationId), index("audit_log_actor_idx").on(t.actorUserId)]);
export type AuditLog = typeof auditLog.$inferSelect;

export type Project = typeof project.$inferSelect;
export type OrgAwsCredentials = typeof orgAwsCredentials.$inferSelect;
export type ProjectSecrets = typeof projectSecrets.$inferSelect;
export type OrgOauthApp = typeof orgOauthApp.$inferSelect;
export type OrgGithubConnection = typeof orgGithubConnection.$inferSelect;
export type OrgGithubAppConfig = typeof orgGithubAppConfig.$inferSelect;
export type OrgAiConfig = typeof orgAiConfig.$inferSelect;
export type ProjectFunctionSecret = typeof projectFunctionSecret.$inferSelect;
export type AuditLogDrain = typeof auditLogDrain.$inferSelect;
export type GithubAuthorization = typeof githubAuthorization.$inferSelect;
export type GithubConnection = typeof githubConnection.$inferSelect;
export type OrgVercelConnection = typeof orgVercelConnection.$inferSelect;
export type ProjectRepoConnection = typeof projectRepoConnection.$inferSelect;
export type ProjectPrivatelinkAccount = typeof projectPrivatelinkAccount.$inferSelect;
