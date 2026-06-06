import { pgTable, uuid, text, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";
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

export type Project = typeof project.$inferSelect;
export type OrgAwsCredentials = typeof orgAwsCredentials.$inferSelect;
