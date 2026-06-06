import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { existsSync } from "node:fs";
import { beforeEach } from "vitest";

// Runs once per test file, before the test module is imported.
const container = await new PostgreSqlContainer("postgres:16-alpine").start();

process.env.DATABASE_URL = container.getConnectionUri();
process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.ENCRYPTION_KEY = "a".repeat(64);

// Import AFTER env is set so the lazy db client binds to the container.
const { db, pool } = await import("../../src/db/client");

// Migrations are generated in a later task; only migrate once they exist.
const migrationsFolder = "./src/db/migrations";
if (existsSync(`${migrationsFolder}/meta/_journal.json`)) {
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  await migrate(db, { migrationsFolder });
}

// Truncate whatever tables currently exist (none before migrations are added).
beforeEach(async () => {
  const { rows } = await pool.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public'`,
  );
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(", ");
  await pool.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
});
