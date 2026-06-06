# Phase 0 — Foundations & Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `supabase-console` control plane skeleton with first-run install that creates an invite-only admin account and a working session model.

**Architecture:** A Node service (Hono HTTP + Zod validation) backed by Postgres via Drizzle. Authentication is delegated to better-auth (email/password + httpOnly sessions), with the `admin` and `organization` plugins registered so their tables ship in the first migration. Public sign-up is blocked via a better-auth `databaseHooks` gate; the first admin is bootstrapped through a race-safe install endpoint. The Hono app is built in `app.ts` (no port binding) so integration tests can run it in-process against a throwaway Postgres (Testcontainers).

**Tech Stack:** TypeScript (strict, ESM), pnpm, Hono, Zod, Drizzle ORM + drizzle-kit, node-postgres (`pg`), better-auth, Vitest, `@testcontainers/postgresql`, tsx (dev), tsup (build).

**Spec:** `docs/superpowers/specs/2026-06-06-phase-0-foundations-install-design.md`

**Conventions:** Conventional Commits (contract §7). Commit after every green step. Per contract §0 the canonical entry point is the `pointless` CLI, but until the manifest is wired and validated we run the underlying pnpm scripts directly (this is the one allowed exception — bootstrapping the manifest itself). After Task 2, prefer `pointless <verb>` where available.

---

## Design refinements over the spec (read before starting)

1. **Invite-only gate.** Instead of `emailAndPassword.disableSignUp`, we use a `databaseHooks.user.create.before` hook that throws `APIError("FORBIDDEN", { message: "Signup is disabled" })` when a user already exists. This blocks public sign-up after install while letting the first-admin bootstrap through, and Phase 1 will extend the same hook to allow invited emails.
2. **`isInstalled()` derives from user existence**, not the marker row: `SELECT count(*) FROM "user" > 0`. This is race-safe and self-healing. The `installation` table still exists to hold `installed_at` and future instance settings, but it is not the authority for "installed".
3. **Race-safe setup.** `setup()` runs inside a transaction that first takes a Postgres **transaction-level advisory lock** (`pg_advisory_xact_lock`), re-checks the user count, then performs the sign-up and writes the marker. Concurrent setup calls serialize on the lock; the loser sees a user already exists and returns 409.

---

## File structure (what each file owns)

| File | Responsibility |
|------|----------------|
| `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `drizzle.config.ts` | toolchain config |
| `pointless.toml` | org-contract manifest (verbs, env, deploy target) |
| `CLAUDE.md`, `README.md`, `.env.example`, `.gitignore` | contract scaffolding |
| `src/config/env.ts` | Zod-validated env loader (typed `env`) |
| `src/db/client.ts` | `pg` Pool + Drizzle client bound to the full schema |
| `src/db/auth-schema.ts` | better-auth tables — **generated** by the better-auth CLI |
| `src/db/schema.ts` | our `installation` table + re-export of `auth-schema` |
| `src/db/migrations/` | drizzle-kit generated SQL |
| `src/auth/permissions.ts` | access-control statement + Owner/Administrator/Developer roles |
| `src/auth/auth.ts` | the `betterAuth(...)` instance (adapter, plugins, invite-only hook) |
| `src/install/service.ts` | `isInstalled()`, `setup()` (advisory-locked) |
| `src/install/routes.ts` | `GET /install/status`, `POST /install/setup` Hono sub-router |
| `src/http/error.ts` | shared JSON error handler + `AppError` |
| `src/http/install-gate.ts` | middleware: 409 on `/api/v1/*` before install |
| `src/http/me.ts` | `GET /api/v1/me` |
| `src/http/health.ts` | `GET /healthz` |
| `src/app.ts` | composes the Hono app (no `listen`) |
| `src/server.ts` | entrypoint: binds the port |
| `tests/helpers/setup.ts` | Vitest setup file: starts Testcontainers Postgres, migrates, exposes `resetDb` |
| `tests/*.test.ts` | integration tests |

---

## Task 1: Scaffold the repo to the org contract

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `.gitignore`, `.env.example`, `pointless.toml`, `CLAUDE.md`, `README.md`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "supabase-console",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsup",
    "start": "node dist/server.js",
    "test": "vitest run",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "migrate": "drizzle-kit migrate",
    "db:generate": "drizzle-kit generate",
    "auth:generate": "better-auth generate --config src/auth/auth.ts --output src/db/auth-schema.ts -y"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run:
```bash
pnpm add hono @hono/node-server zod better-auth drizzle-orm pg
pnpm add -D typescript tsx tsup vitest drizzle-kit @better-auth/cli @testcontainers/postgresql @types/node @types/pg eslint
```
Expected: `node_modules/` populated, `pnpm-lock.yaml` created, `package.json` gains dependency versions.

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": false,
    "noUncheckedIndexedAccess": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["src", "tests", "*.config.ts"]
}
```

- [ ] **Step 4: Create `tsup.config.ts`**

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  outDir: "dist",
  target: "node20",
  clean: true,
  sourcemap: true,
});
```

- [ ] **Step 5: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/helpers/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
```

> `fileParallelism: false` so test files share one Postgres container start at a time rather than spinning up many in parallel on a dev laptop.

- [ ] **Step 6: Create `.gitignore`**

```
node_modules/
dist/
.env
*.log
```

- [ ] **Step 7: Create `.env.example`** (mirrors `pointless.toml [env]`, contract §6)

```
DATABASE_URL=postgres://postgres:postgres@localhost:5432/supabase_console
BETTER_AUTH_SECRET=replace-with-a-long-random-string
BETTER_AUTH_URL=http://localhost:3000
PORT=3000
LOG_LEVEL=info
```

- [ ] **Step 8: Create `pointless.toml`**

```toml
[repo]
name    = "supabase-console"
type    = "app"
stack   = "ts-node"
version = "0.1.0"

[commands]
build  = "pnpm build"
test   = "pnpm test"
dev    = "pnpm dev"
lint   = "pnpm lint && pnpm typecheck"
deploy = "true"

[commands.run]
migrate       = "pnpm migrate"
db-generate   = "pnpm db:generate"
auth-generate = "pnpm auth:generate"

[env]
required = ["DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"]
optional = ["PORT", "LOG_LEVEL"]

[deploy]
target = "none"
```

> If `pointless` rejects the `[commands.run]` table shape or a no-op `deploy`, adjust to the CLI's actual schema — the intent is: standard verbs map to pnpm scripts, `migrate`/`db-generate`/`auth-generate` are custom verbs, deploy is a no-op for Phase 0.

- [ ] **Step 9: Create `CLAUDE.md`** (thin, per contract — only if the base file exists)

```md
@.pointless/CLAUDE.base.md

# supabase-console — repo-specific notes

Phase 0 = foundations & install. See docs/superpowers/specs/ and docs/superpowers/plans/.
Control plane = Node service (Hono + Drizzle + Postgres + better-auth). API-first; UI is Phase 4.
```

> Note: `.pointless/CLAUDE.base.md` is normally written by `pointless` on scaffold. If it does not exist yet, run the CLI's scaffold/sync to produce it, or omit the `@import` line until it does. Do **not** hand-author the base file.

- [ ] **Step 10: Create `README.md`** (must start with `pointless` usage, contract §2)

```md
# supabase-console

Multi-tenant control plane for provisioning and managing Supabase instances.

## Usage

```bash
pointless dev      # run locally with hot reload
pointless test     # run the test suite
pointless lint     # format + lint + typecheck
pointless build    # produce release artifacts
pointless run migrate   # apply database migrations
```

## Local setup

1. Copy `.env.example` to `.env` and fill in values.
2. `pointless run migrate` to apply migrations.
3. `pointless dev`, then POST to `/api/v1/install/setup` to create the first admin.
```

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: scaffold supabase-console to org contract"
```

---

## Task 2: Env config loader

**Files:**
- Create: `src/config/env.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/config.test.ts
import { describe, it, expect } from "vitest";
import { parseEnv } from "../src/config/env";

describe("parseEnv", () => {
  it("parses a valid environment", () => {
    const env = parseEnv({
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      BETTER_AUTH_SECRET: "x".repeat(32),
      BETTER_AUTH_URL: "http://localhost:3000",
    });
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("throws when a required var is missing", () => {
    expect(() => parseEnv({ BETTER_AUTH_SECRET: "x".repeat(32) })).toThrow(
      /DATABASE_URL/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/config.test.ts`
Expected: FAIL — cannot find module `../src/config/env`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/config/env.ts
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(16),
  BETTER_AUTH_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment configuration: ${missing}`);
  }
  return result.data;
}

export const env: Env = parseEnv();
```

> `parseEnv` is pure (takes a source) so it is unit-testable without mutating `process.env`. The `env` singleton is what the app imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/config.test.ts`
Expected: PASS (2 tests).

> This test file does not import `env` (the singleton), so Testcontainers setup is not required for it; it still loads `tests/helpers/setup.ts` (created in Task 4), which is fine.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts tests/config.test.ts
git commit -m "feat: add zod-validated env loader"
```

---

## Task 3: Database client + installation schema + auth-schema placeholder

**Files:**
- Create: `src/db/auth-schema.ts` (placeholder — regenerated in Task 5), `src/db/schema.ts`, `src/db/client.ts`, `drizzle.config.ts`

- [ ] **Step 1: Create the auth-schema placeholder**

The better-auth CLI will overwrite this in Task 5, but it must exist now so imports resolve.

```ts
// src/db/auth-schema.ts
// Placeholder — overwritten by `pnpm auth:generate` in Task 5.
export {};
```

- [ ] **Step 2: Create our schema with the `installation` table**

```ts
// src/db/schema.ts
import { pgTable, boolean, timestamp } from "drizzle-orm/pg-core";

// Single-row marker. `id` is a constant `true` with a unique primary key,
// guaranteeing at most one installation row. Authority for "installed?" is the
// user count (see install service); this table holds metadata + future settings.
export const installation = pgTable("installation", {
  id: boolean("id").primaryKey().default(true),
  installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
  allowPublicSignup: boolean("allow_public_signup").notNull().default(false),
});

export * from "./auth-schema";
```

- [ ] **Step 3: Create the Drizzle client**

```ts
// src/db/client.ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../config/env";
import * as schema from "./schema";

export const pool = new Pool({ connectionString: env.DATABASE_URL });
export const db = drizzle({ client: pool, schema });
export type DB = typeof db;
```

- [ ] **Step 4: Create `drizzle.config.ts`**

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no type errors; `export {}` placeholder yields an empty re-export).

- [ ] **Step 6: Commit**

```bash
git add src/db/ drizzle.config.ts
git commit -m "feat: add drizzle client and installation schema"
```

---

## Task 4: Test database harness (Testcontainers)

**Files:**
- Create: `tests/helpers/setup.ts`

> Built before the install service so service/integration tests have a real Postgres. This file is referenced by `vitest.config.ts` `setupFiles`, so it runs before any test module is imported — meaning it sets `process.env` (DATABASE_URL etc.) before the app's singletons (`env`, `db`, `auth`) are constructed.

- [ ] **Step 1: Write the setup file**

```ts
// tests/helpers/setup.ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { beforeEach } from "vitest";

let container: StartedPostgreSqlContainer | undefined;

// Top-level await: runs once per test file, before the test module is imported.
container = await new PostgreSqlContainer("postgres:16-alpine").start();

process.env.DATABASE_URL = container.getConnectionUri();
process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.BETTER_AUTH_URL = "http://localhost:3000";

// Import the migrator AFTER env is set so the client binds to the container.
const { db, pool } = await import("../../src/db/client");
const { migrate } = await import("drizzle-orm/node-postgres/migrator");
await migrate(db, { migrationsFolder: "./src/db/migrations" });

// Truncate all tables between tests for isolation.
const TABLES = [
  "installation",
  "invitation",
  "member",
  "organization",
  "verification",
  "account",
  "session",
  `"user"`,
];

beforeEach(async () => {
  await pool.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
});
```

> The `migrate` call requires migrations to exist; the initial migration is generated in Task 5. Until then, `migrate` over an empty folder is a no-op (it will succeed with zero migrations). After Task 5 it creates all tables.

- [ ] **Step 2: Verify the harness boots**

Run: `pnpm vitest run tests/config.test.ts`
Expected: PASS — confirms a container starts, migrations run (zero so far), and the existing config tests still pass. (Requires Docker running locally.)

- [ ] **Step 3: Commit**

```bash
git add tests/helpers/setup.ts
git commit -m "test: add testcontainers postgres harness"
```

---

## Task 5: Auth instance, roles, and generated schema

**Files:**
- Create: `src/auth/permissions.ts`, `src/auth/auth.ts`, `src/auth/index.ts`
- Regenerate: `src/db/auth-schema.ts`
- Create: `src/db/migrations/0000_init.sql` (via drizzle-kit)

- [ ] **Step 1: Define the access-control roles**

```ts
// src/auth/permissions.ts
import { createAccessControl } from "better-auth/plugins/access";

// Resources the control plane authorizes. `project` covers project lifecycle
// and content; `billing` is a parity slot that maps to nothing in this product.
const statement = {
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  project: ["create", "update", "delete", "content"],
  billing: ["manage"],
} as const;

export const ac = createAccessControl(statement);

export const owner = ac.newRole({
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  project: ["create", "update", "delete", "content"],
  billing: ["manage"],
});

export const administrator = ac.newRole({
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  project: ["create", "update", "delete", "content"],
  billing: ["manage"],
});

export const developer = ac.newRole({
  project: ["content"],
});
```

- [ ] **Step 2: Create the better-auth instance**

```ts
// src/auth/auth.ts
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization } from "better-auth/plugins";
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { env } from "../config/env";
import { ac, owner, administrator, developer } from "./permissions";

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  database: drizzleAdapter(db, { provider: "pg" }),
  emailAndPassword: { enabled: true },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          // Invite-only: allow creation only when no user exists yet (the
          // first-admin bootstrap). Phase 1 extends this to allow invited emails.
          const [{ count }] = await db.execute<{ count: number }>(
            sql`select count(*)::int as count from "user"`,
          );
          if (count > 0) {
            throw new APIError("FORBIDDEN", { message: "Signup is disabled" });
          }
          return { data: user };
        },
      },
    },
  },
  plugins: [
    admin(),
    organization({
      ac,
      roles: { owner, administrator, developer },
    }),
  ],
});

export type Auth = typeof auth;
```

- [ ] **Step 3: Re-export for ergonomics**

```ts
// src/auth/index.ts
export { auth, type Auth } from "./auth";
```

- [ ] **Step 4: Generate the better-auth Drizzle schema**

Run: `pnpm auth:generate`
Expected: `src/db/auth-schema.ts` is overwritten with `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation` table definitions (plus admin-plugin fields on `user`). (Requires the `.env`/env vars to be loadable; ensure a local `.env` exists.)

- [ ] **Step 5: Generate the SQL migration**

Run: `pnpm db:generate`
Expected: `src/db/migrations/0000_init.sql` created containing `CREATE TABLE` for all auth tables + `installation`. A `meta/` journal is written alongside.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: PASS — `schema.ts` now re-exports real tables; `client.ts` binds them.

- [ ] **Step 7: Commit**

```bash
git add src/auth/ src/db/auth-schema.ts src/db/migrations/
git commit -m "feat: configure better-auth with roles and invite-only gate"
```

---

## Task 6: Install service (TDD)

**Files:**
- Create: `src/install/service.ts`
- Test: `tests/install-service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/install-service.test.ts
import { describe, it, expect } from "vitest";
import { isInstalled, setup, AlreadyInstalledError } from "../src/install/service";

describe("install service", () => {
  it("reports not installed on a fresh database", async () => {
    expect(await isInstalled()).toBe(false);
  });

  it("setup creates the first admin and flips installed to true", async () => {
    const res = await setup({
      name: "Admin",
      email: "admin@example.com",
      password: "supersecret123",
    });
    expect(res.headers.get("set-cookie")).toBeTruthy();
    expect(await isInstalled()).toBe(true);
  });

  it("rejects a second setup with AlreadyInstalledError", async () => {
    await setup({ name: "Admin", email: "admin@example.com", password: "supersecret123" });
    await expect(
      setup({ name: "Two", email: "two@example.com", password: "supersecret123" }),
    ).rejects.toBeInstanceOf(AlreadyInstalledError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/install-service.test.ts`
Expected: FAIL — cannot find module `../src/install/service`.

- [ ] **Step 3: Write the implementation**

```ts
// src/install/service.ts
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { installation } from "../db/schema";
import { auth } from "../auth";

export class AlreadyInstalledError extends Error {
  constructor() {
    super("Already installed");
    this.name = "AlreadyInstalledError";
  }
}

// Stable key for the advisory lock that serializes install attempts.
const INSTALL_LOCK_KEY = 4711n;

export async function userCount(): Promise<number> {
  const [row] = await db.execute<{ count: number }>(
    sql`select count(*)::int as count from "user"`,
  );
  return row?.count ?? 0;
}

export async function isInstalled(): Promise<boolean> {
  return (await userCount()) > 0;
}

export interface SetupInput {
  name: string;
  email: string;
  password: string;
}

/**
 * Creates the first admin. Race-safe: serializes concurrent callers on a
 * transaction-level advisory lock, re-checks the user count inside the lock,
 * then signs the user up and writes the installation marker.
 * Returns the better-auth Response (carries the Set-Cookie session header).
 */
export async function setup(input: SetupInput): Promise<Response> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${INSTALL_LOCK_KEY})`);

    const [row] = await tx.execute<{ count: number }>(
      sql`select count(*)::int as count from "user"`,
    );
    if ((row?.count ?? 0) > 0) {
      throw new AlreadyInstalledError();
    }

    const response = await auth.api.signUpEmail({
      body: { name: input.name, email: input.email, password: input.password },
      asResponse: true,
    });
    if (!response.ok) {
      throw new Error(`Failed to create admin (status ${response.status})`);
    }

    await tx.insert(installation).values({}).onConflictDoNothing();
    return response;
  });
}
```

> Note: `signUpEmail` runs on the pool (not `tx`), so the new user is committed independently — fine, because `isInstalled()` derives from the user count. The advisory lock still serializes setup callers correctly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/install-service.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/install/service.ts tests/install-service.test.ts
git commit -m "feat: add race-safe install service"
```

---

## Task 7: HTTP error handling

**Files:**
- Create: `src/http/error.ts`
- Test: `tests/error.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/error.test.ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { AppError, onError } from "../src/http/error";

describe("error handler", () => {
  const app = new Hono();
  app.onError(onError);
  app.get("/boom", () => {
    throw new AppError(409, "already_installed", "Already installed");
  });
  app.get("/oops", () => {
    throw new Error("kaboom");
  });

  it("renders AppError as structured JSON", async () => {
    const res = await app.request("/boom");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "already_installed", message: "Already installed" },
    });
  });

  it("renders unknown errors as 500 internal_error", async () => {
    const res = await app.request("/oops");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: "internal_error", message: "Internal server error" },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/error.test.ts`
Expected: FAIL — cannot find module `../src/http/error`.

- [ ] **Step 3: Write the implementation**

```ts
// src/http/error.ts
import type { Context } from "hono";

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function onError(err: Error, c: Context): Response {
  if (err instanceof AppError) {
    return c.json(
      { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } },
      err.status as 400 | 401 | 409 | 500,
    );
  }
  return c.json({ error: { code: "internal_error", message: "Internal server error" } }, 500);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/error.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/http/error.ts tests/error.test.ts
git commit -m "feat: add structured http error handler"
```

---

## Task 8: Health, me, and install-gate; compose the app

**Files:**
- Create: `src/http/health.ts`, `src/http/me.ts`, `src/http/install-gate.ts`, `src/install/routes.ts`, `src/app.ts`
- Test: `tests/app.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/app.test.ts
import { describe, it, expect } from "vitest";
import { app } from "../src/app";

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("app", () => {
  it("GET /healthz is always 200", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("install status starts false and /api/v1/me is gated to 409 before install", async () => {
    expect(await (await app.request("/api/v1/install/status")).json()).toEqual({ installed: false });
    const me = await app.request("/api/v1/me");
    expect(me.status).toBe(409);
    expect((await me.json()).error.code).toBe("not_installed");
  });

  it("setup creates the admin, returns a session cookie, and flips status", async () => {
    const res = await app.request(
      "/api/v1/install/setup",
      json({ name: "Admin", email: "admin@example.com", password: "supersecret123" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeTruthy();
    expect(await (await app.request("/api/v1/install/status")).json()).toEqual({ installed: true });
  });

  it("rejects a second setup with 409 already_installed", async () => {
    await app.request("/api/v1/install/setup", json({ name: "A", email: "a@example.com", password: "supersecret123" }));
    const res = await app.request(
      "/api/v1/install/setup",
      json({ name: "B", email: "b@example.com", password: "supersecret123" }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("already_installed");
  });

  it("blocks public sign-up after install", async () => {
    await app.request("/api/v1/install/setup", json({ name: "A", email: "a@example.com", password: "supersecret123" }));
    const res = await app.request(
      "/api/auth/sign-up/email",
      json({ name: "Intruder", email: "intruder@example.com", password: "supersecret123" }),
    );
    expect(res.ok).toBe(false);
  });

  it("logs in and returns the user from /api/v1/me", async () => {
    await app.request("/api/v1/install/setup", json({ name: "Admin", email: "admin@example.com", password: "supersecret123" }));
    const login = await app.request(
      "/api/auth/sign-in/email",
      json({ email: "admin@example.com", password: "supersecret123" }),
    );
    const cookie = login.headers.get("set-cookie") ?? "";
    const me = await app.request("/api/v1/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    expect((await me.json()).user.email).toBe("admin@example.com");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/app.test.ts`
Expected: FAIL — cannot find module `../src/app`.

- [ ] **Step 3: Create the health route**

```ts
// src/http/health.ts
import { Hono } from "hono";

export const health = new Hono();
health.get("/healthz", (c) => c.json({ status: "ok" }));
```

- [ ] **Step 4: Create the `me` route**

```ts
// src/http/me.ts
import { Hono } from "hono";
import { auth } from "../auth";
import { AppError } from "./error";

export const me = new Hono();
me.get("/api/v1/me", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    throw new AppError(401, "unauthenticated", "Not authenticated");
  }
  return c.json({ user: session.user, session: session.session });
});
```

- [ ] **Step 5: Create the install-gate middleware**

```ts
// src/http/install-gate.ts
import { createMiddleware } from "hono/factory";
import { isInstalled } from "../install/service";
import { AppError } from "./error";

// Applied to /api/v1/* except the install routes. Returns 409 before install
// so the UI knows to redirect to /install/setup.
export const installGate = createMiddleware(async (c, next) => {
  const path = c.req.path;
  if (path.startsWith("/api/v1/install")) {
    return next();
  }
  if (!(await isInstalled())) {
    throw new AppError(409, "not_installed", "Instance is not installed");
  }
  return next();
});
```

- [ ] **Step 6: Create the install routes**

```ts
// src/install/routes.ts
import { Hono } from "hono";
import { z } from "zod";
import { isInstalled, setup, AlreadyInstalledError } from "./service";
import { AppError } from "../http/error";

const setupSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

export const install = new Hono();

install.get("/api/v1/install/status", async (c) => {
  return c.json({ installed: await isInstalled() });
});

install.post("/api/v1/install/setup", async (c) => {
  const parsed = setupSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new AppError(400, "validation_error", "Invalid setup payload", parsed.error.flatten());
  }
  try {
    // better-auth Response carries Set-Cookie; return it directly.
    return await setup(parsed.data);
  } catch (err) {
    if (err instanceof AlreadyInstalledError) {
      throw new AppError(409, "already_installed", "Instance is already installed");
    }
    throw err;
  }
});
```

- [ ] **Step 7: Compose the app**

```ts
// src/app.ts
import { Hono } from "hono";
import { auth } from "./auth";
import { onError } from "./http/error";
import { installGate } from "./http/install-gate";
import { health } from "./http/health";
import { me } from "./http/me";
import { install } from "./install/routes";

export const app = new Hono();

app.onError(onError);

// Health and better-auth are exempt from the install gate.
app.route("/", health);
app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// Everything else under /api/v1 is gated until install completes.
app.use("/api/v1/*", installGate);
app.route("/", install);
app.route("/", me);
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm vitest run tests/app.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 9: Commit**

```bash
git add src/http/ src/install/routes.ts src/app.ts tests/app.test.ts
git commit -m "feat: compose hono app with install, me, health, and gate"
```

---

## Task 9: Server entrypoint

**Files:**
- Create: `src/server.ts`

- [ ] **Step 1: Write the entrypoint**

```ts
// src/server.ts
import { serve } from "@hono/node-server";
import { app } from "./app";
import { env } from "./config/env";

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`supabase-console listening on http://localhost:${info.port}`);
});
```

- [ ] **Step 2: Verify the build compiles**

Run: `pnpm build`
Expected: `dist/server.js` produced, no errors.

- [ ] **Step 3: Smoke-test boot (manual, requires a real Postgres + `.env`)**

Run: `pnpm migrate && pnpm dev`
Expected: logs `supabase-console listening on http://localhost:3000`. `curl localhost:3000/healthz` → `{"status":"ok"}`; `curl localhost:3000/api/v1/install/status` → `{"installed":false}`.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat: add node server entrypoint"
```

---

## Task 10: Final verification

- [ ] **Step 1: Run the full suite**

Run: `pnpm test`
Expected: all suites green (config, error, install-service, app). Requires Docker for Testcontainers.

- [ ] **Step 2: Lint + typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: clean. (If ESLint is unconfigured, add a minimal `eslint.config.js` flat config for TS, or set `lint` to `pnpm typecheck` only and note it — do not leave `lint` broken.)

- [ ] **Step 3: Confirm contract alignment**

Verify manually:
- `pointless.toml [env]` and `.env.example` list the same vars (contract §6). ✓
- No `.env` or secrets committed (`git status` clean of secrets). ✓
- `installation`, `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation` all present in `src/db/migrations/0000_init.sql`. ✓

- [ ] **Step 4: Commit any fixups**

```bash
git add -A
git commit -m "chore: phase 0 final verification fixups"
```

---

## Definition of done

- `pnpm test` (or `pointless test`) passes: install status transitions, setup happy path + session cookie, second-setup 409, public sign-up blocked, login + `/api/v1/me`, install-gate 409-before / pass-after.
- `pnpm lint && pnpm typecheck` clean.
- Manifest and `.env.example` agree on env vars; no secrets in git.
- better-auth `organization` schema present in the initial migration (unused until Phase 1).
- App boots and serves `/healthz` and `/api/v1/install/status`.

## Notes carried to Phase 1

- Extend the `databaseHooks.user.create.before` gate to allow emails with a pending `invitation` (so invitees can set a password), in addition to the zero-user bootstrap.
- Wire the organization plugin's create/invite/settings endpoints into `/api/v1` and enforce the `owner`/`administrator`/`developer` roles defined in `src/auth/permissions.ts`.
