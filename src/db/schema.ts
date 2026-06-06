import { pgTable, uuid, text, boolean, jsonb, timestamp, integer } from "drizzle-orm/pg-core";
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
  postgresType: text("postgres_type").notNull().default("postgres"), // postgres | orioledb
  status: text("status").notNull().default("provisioning"), // provisioning|active|paused|removing|failed
  dataApiEnabled: boolean("data_api_enabled").notNull().default(true),
  autoExposeNewTables: boolean("auto_expose_new_tables").notNull().default(true),
  autoEnableRls: boolean("auto_enable_rls").notNull().default(true),
  dbPasswordEncrypted: text("db_password_encrypted").notNull(),
  connection: jsonb("connection"),
  kongHttpPort: integer("kong_http_port"),
  kongHttpsPort: integer("kong_https_port"),
  dbPort: integer("db_port"),
  failureReason: text("failure_reason"),
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

export type Project = typeof project.$inferSelect;
export type OrgAwsCredentials = typeof orgAwsCredentials.$inferSelect;
export type ProjectSecrets = typeof projectSecrets.$inferSelect;
export type OrgOauthApp = typeof orgOauthApp.$inferSelect;
