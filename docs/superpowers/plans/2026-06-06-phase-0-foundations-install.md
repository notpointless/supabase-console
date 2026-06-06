# Phase 0 — Foundations & Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `supabase-console` control plane skeleton with first-run install that creates an invite-only admin account and a working session model, with the install/identity logic packaged as a custom better-auth plugin.

**Architecture:** A Node service (Hono HTTP + Zod validation) backed by Postgres via Drizzle. Authentication is delegated to better-auth (email/password + httpOnly sessions). A **custom `consolePlugin()`** owns the install domain: it declares the `installation` table (plugin `schema`), mounts `/install/status` and `/install/setup` endpoints under `/api/auth/install/*`, and registers a `before` hook that blocks public sign-up. The `admin` and `organization` plugins are also registered so their tables ship in the first migration and our Owner/Administrator/Developer roles are defined. The Hono app is built in `app.ts` (no port binding) so integration tests run it in-process against a throwaway Postgres (Testcontainers).

**Tech Stack:** TypeScript (strict, ESM), pnpm, Hono, Zod, Drizzle ORM + drizzle-kit, node-postgres (`pg`), better-auth (+ `@better-auth/cli`), Vitest, `@testcontainers/postgresql`, tsx (dev), tsup (build).

**Spec:** `docs/superpowers/specs/2026-06-06-phase-0-foundations-install-design.md`

**API verification:** The plugin APIs in this plan were checked against better-auth's docs (`https://better-auth.com/llms.txt` → concepts/plugins, concepts/database) and its `sign-up.ts` source. Confirmed: `createAuthEndpoint`/`createAuthMiddleware` from `better-auth/api`; plugin `schema` field types `string|number|boolean|date` with `required`/`defaultValue`/`references`; `hooks.before` `[{ matcher, handler }]`; `ctx.context.{internalAdapter, adapter, password}`. Note: `defaultValue` applies only in the JS layer (DB column stays optional). `setSessionCookie` / `internalAdapter.*` / `ctx.context.password.hash` are not in the prose docs but match better-auth's own `sign-up.ts` internals — resolve their import paths via TypeScript at implementation time.

**Conventions:** Conventional Commits (contract §7). Commit after every green step. Per contract §0 the canonical entry point is the `pointless` CLI, but until the manifest is wired and validated we run the underlying pnpm scripts directly (the one allowed exception — bootstrapping the manifest itself).

---

## Design decisions & refinements over the spec (read before starting)

1. **Install is a better-auth plugin.** Rather than an `installation` table in our own Drizzle schema + install routes in Hono `/api/v1/*`, a custom `consolePlugin()` owns all of it. Consequence: **install endpoints move to `/api/auth/install/status` and `/api/auth/install/setup`** (under better-auth's base path), not `/api/v1/install/*` as the spec drafted. `/api/v1/me` and the install-gate middleware remain in our Hono layer.
2. **Public sign-up is blocked unconditionally.** A plugin `before` hook matching `/sign-up/email` always throws `FORBIDDEN`. Users are only ever created by the install setup endpoint (Phase 0) or by invite acceptance (Phase 1, which will create users server-side). This is simpler and safer than a conditional gate — there is no window in which a stranger can self-register.
3. **`isInstalled()` derives from user existence** (`SELECT count(*) FROM "user" > 0`), implemented with **raw SQL** so it does not import any generated table — this avoids an import cycle when `better-auth generate` loads `auth.ts`. The `installation` table holds `installed_at` + future settings but is not the authority for "installed".
4. **Race-safe setup.** The setup endpoint takes a Postgres **advisory lock** (`pg_advisory_lock`) on a dedicated pool connection around the check-and-create critical section, so two concurrent setup calls cannot both create an admin.

---

## File structure (what each file owns)

| File | Responsibility |
|------|----------------|
| `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `drizzle.config.ts` | toolchain config |
| `pointless.toml` | org-contract manifest (verbs, env, deploy target) |
| `CLAUDE.md`, `README.md`, `.env.example`, `.gitignore` | contract scaffolding |
| `src/config/env.ts` | Zod-validated env loader (typed `env`) |
| `src/db/client.ts` | `pg` Pool + Drizzle client bound to the schema |
| `src/db/auth-schema.ts` | better-auth + plugin tables — **generated** by `@better-auth/cli` |
| `src/db/schema.ts` | re-export of `auth-schema` (drizzle-kit entry) |
| `src/db/migrations/` | drizzle-kit generated SQL |
| `src/install/status.ts` | shared `isInstalled()` (raw count, no generated imports) |
| `src/auth/permissions.ts` | access-control statement + Owner/Administrator/Developer roles |
| `src/auth/console-plugin.ts` | the custom plugin: `installation` schema, install endpoints, sign-up block hook |
| `src/auth/auth.ts` | the `betterAuth(...)` instance (adapter + plugins) |
| `src/http/error.ts` | shared JSON error handler + `AppError` |
| `src/http/install-gate.ts` | middleware: 409 on `/api/v1/*` before install |
| `src/http/me.ts` | `GET /api/v1/me` |
| `src/http/health.ts` | `GET /healthz` |
| `src/app.ts` | composes the Hono app (no `listen`) |
| `src/server.ts` | entrypoint: binds the port |
| `tests/helpers/setup.ts` | Vitest setup: starts Testcontainers Postgres, migrates, truncates between tests |
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
    "auth:generate": "npx @better-auth/cli generate --config src/auth/auth.ts --output src/db/auth-schema.ts --yes"
  }
}
```

> `auth:generate` flags target the current `@better-auth/cli`. If the installed CLI uses different flag names (e.g. it auto-detects `src/auth/auth.ts`), adjust — the intent is: read the auth config, emit a Drizzle schema for all registered plugins to `src/db/auth-schema.ts`.

- [ ] **Step 2: Install dependencies**

Run:
```bash
pnpm add hono @hono/node-server zod better-auth drizzle-orm pg
pnpm add -D typescript tsx tsup vitest drizzle-kit @better-auth/cli @testcontainers/postgresql @types/node @types/pg eslint
```
Expected: `node_modules/` populated, `pnpm-lock.yaml` created.

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

> If `pointless` rejects `[commands.run]` or a no-op `deploy`, adjust to the CLI's actual schema; the intent is: standard verbs → pnpm scripts, `migrate`/`db-generate`/`auth-generate` → custom verbs, deploy → no-op for Phase 0.

- [ ] **Step 9: Create `CLAUDE.md`** (thin, per contract)

```md
@.pointless/CLAUDE.base.md

# supabase-console — repo-specific notes

Phase 0 = foundations & install. See docs/superpowers/specs/ and docs/superpowers/plans/.
Control plane = Node service (Hono + Drizzle + Postgres + better-auth). API-first; UI is Phase 4.
Install + invite-only identity is a custom better-auth plugin (src/auth/console-plugin.ts).
```

> `.pointless/CLAUDE.base.md` is written by `pointless` on scaffold. If it does not exist yet, run the CLI's scaffold/sync to produce it, or omit the `@import` line until it does. Never hand-author the base file.

- [ ] **Step 10: Create `README.md`** (must start with `pointless` usage, contract §2)

```md
# supabase-console

Multi-tenant control plane for provisioning and managing Supabase instances.

## Usage

```bash
pointless dev           # run locally with hot reload
pointless test          # run the test suite
pointless lint          # format + lint + typecheck
pointless build         # produce release artifacts
pointless run migrate   # apply database migrations
```

## Local setup

1. Copy `.env.example` to `.env` and fill in values.
2. `pointless run migrate` to apply migrations.
3. `pointless dev`, then POST to `/api/auth/install/setup` to create the first admin.
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
    expect(() => parseEnv({ BETTER_AUTH_SECRET: "x".repeat(32) })).toThrow(/DATABASE_URL/);
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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/config.test.ts`
Expected: PASS (2 tests). (Loads `tests/helpers/setup.ts` from Task 4, which starts a container; this test does not depend on it but tolerates it.)

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts tests/config.test.ts
git commit -m "feat: add zod-validated env loader"
```

---

## Task 3: Database client + schema entry + auth-schema placeholder

**Files:**
- Create: `src/db/auth-schema.ts` (placeholder — regenerated in Task 5), `src/db/schema.ts`, `src/db/client.ts`, `drizzle.config.ts`

- [ ] **Step 1: Create the auth-schema placeholder**

Overwritten by `pnpm auth:generate` in Task 5, but must exist now so imports resolve.

```ts
// src/db/auth-schema.ts
// Placeholder — overwritten by `pnpm auth:generate` in Task 5.
export {};
```

- [ ] **Step 2: Create the schema entry (drizzle-kit reads this)**

```ts
// src/db/schema.ts
// All tables (auth core + admin + organization + the consolePlugin's
// `installation`) are generated into auth-schema.ts by `better-auth generate`.
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
Expected: PASS (empty re-export compiles).

- [ ] **Step 6: Commit**

```bash
git add src/db/ drizzle.config.ts
git commit -m "feat: add drizzle client and schema entry"
```

---

## Task 4: Test database harness (Testcontainers)

**Files:**
- Create: `tests/helpers/setup.ts`

> Referenced by `vitest.config.ts` `setupFiles`, so it runs before any test module is imported — meaning it sets `process.env` (DATABASE_URL etc.) before the app's singletons (`env`, `db`, `auth`) are constructed.

- [ ] **Step 1: Write the setup file**

```ts
// tests/helpers/setup.ts
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { beforeEach } from "vitest";

// Top-level await: runs once per test file, before the test module is imported.
const container = await new PostgreSqlContainer("postgres:16-alpine").start();

process.env.DATABASE_URL = container.getConnectionUri();
process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.BETTER_AUTH_URL = "http://localhost:3000";

// Import AFTER env is set so the client binds to the container.
const { db, pool } = await import("../../src/db/client");
const { migrate } = await import("drizzle-orm/node-postgres/migrator");
await migrate(db, { migrationsFolder: "./src/db/migrations" });

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

> Until Task 5 generates migrations, `migrate` over an empty folder is a no-op (succeeds with zero migrations). After Task 5 it creates all tables. If a test runs before Task 5, the `TRUNCATE` in `beforeEach` would fail on missing tables — that is expected; Task 4's verification only runs the config test, which has no `beforeEach`-truncated tables of its own. Run full integration tests only after Task 5.

- [ ] **Step 2: Verify the harness boots**

Run: `pnpm vitest run tests/config.test.ts`
Expected: PASS — a container starts, zero migrations run, config tests pass. (Requires Docker running locally.)

- [ ] **Step 3: Commit**

```bash
git add tests/helpers/setup.ts
git commit -m "test: add testcontainers postgres harness"
```

---

## Task 5: Roles, the console plugin, the auth instance, and generated schema

**Files:**
- Create: `src/install/status.ts`, `src/auth/permissions.ts`, `src/auth/console-plugin.ts`, `src/auth/auth.ts`, `src/auth/index.ts`
- Regenerate: `src/db/auth-schema.ts`; Create: `src/db/migrations/0000_init.sql`
- Test: `tests/install-plugin.test.ts`

- [ ] **Step 1: Create the shared install-status helper**

```ts
// src/install/status.ts
import { sql } from "drizzle-orm";
import { db } from "../db/client";

// Raw SQL so this file imports NO generated table — avoids an import cycle when
// `better-auth generate` loads auth.ts. "installed" == at least one user exists.
export async function isInstalled(): Promise<boolean> {
  const { rows } = await db.execute<{ count: number }>(
    sql`select count(*)::int as count from "user"`,
  );
  return (rows[0]?.count ?? 0) > 0;
}
```

- [ ] **Step 2: Define the access-control roles**

```ts
// src/auth/permissions.ts
import { createAccessControl } from "better-auth/plugins/access";

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

- [ ] **Step 3: Write the console plugin**

```ts
// src/auth/console-plugin.ts
import { createAuthEndpoint, createAuthMiddleware, APIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { BetterAuthPlugin } from "better-auth";
import { z } from "zod";
import { pool } from "../db/client";
import { isInstalled } from "../install/status";

// Stable key for the advisory lock that serializes install attempts.
const INSTALL_LOCK_KEY = 4711;

export const consolePlugin = () => {
  return {
    id: "console",
    schema: {
      installation: {
        fields: {
          installedAt: { type: "date", required: true },
          // defaultValue applies only in the JS layer; the DB column is optional.
          // We always pass it explicitly in adapter.create, so this is safe.
          allowPublicSignup: { type: "boolean", defaultValue: false },
        },
      },
    },
    endpoints: {
      installStatus: createAuthEndpoint(
        "/install/status",
        { method: "GET" },
        async (ctx) => {
          return ctx.json({ installed: await isInstalled() });
        },
      ),
      installSetup: createAuthEndpoint(
        "/install/setup",
        {
          method: "POST",
          body: z.object({
            name: z.string().min(1),
            email: z.string().email(),
            password: z.string().min(8),
          }),
        },
        async (ctx) => {
          const client = await pool.connect();
          try {
            // Serialize concurrent setup calls across the check-and-create section.
            await client.query("select pg_advisory_lock($1)", [INSTALL_LOCK_KEY]);

            if (await isInstalled()) {
              throw new APIError("CONFLICT", { message: "Instance is already installed" });
            }

            // Mirror better-auth's signUpEmail internals to create the first admin.
            const hash = await ctx.context.password.hash(ctx.body.password);
            const user = await ctx.context.internalAdapter.createUser({
              email: ctx.body.email.toLowerCase(),
              name: ctx.body.name,
              role: "admin",
              emailVerified: false,
            });
            await ctx.context.internalAdapter.linkAccount({
              userId: user.id,
              providerId: "credential",
              accountId: user.id,
              password: hash,
            });

            await ctx.context.adapter.create({
              model: "installation",
              data: { installedAt: new Date(), allowPublicSignup: false },
            });

            const session = await ctx.context.internalAdapter.createSession(user.id);
            await setSessionCookie(ctx, { session, user });

            return ctx.json({ user });
          } finally {
            await client.query("select pg_advisory_unlock($1)", [INSTALL_LOCK_KEY]);
            client.release();
          }
        },
      ),
    },
    hooks: {
      before: [
        {
          // Public sign-up is never allowed; users come from install or invites.
          matcher: (ctx) => ctx.path === "/sign-up/email",
          handler: createAuthMiddleware(async () => {
            throw new APIError("FORBIDDEN", { message: "Signup is disabled" });
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
};
```

> Import-path notes for the implementer: `createAuthEndpoint`, `createAuthMiddleware`, and `APIError` come from `better-auth/api`; `setSessionCookie` from `better-auth/cookies`. If the installed version re-exports these elsewhere, follow the type resolution — the usage (mirroring `signUpEmail`) is correct. `createSession(user.id)` is the documented single-arg form; an optional second `dontRememberMe` boolean exists if needed.

- [ ] **Step 4: Create the better-auth instance**

```ts
// src/auth/auth.ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization } from "better-auth/plugins";
import { db } from "../db/client";
import { env } from "../config/env";
import { ac, owner, administrator, developer } from "./permissions";
import { consolePlugin } from "./console-plugin";

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  database: drizzleAdapter(db, { provider: "pg" }),
  emailAndPassword: { enabled: true },
  plugins: [
    admin(),
    organization({ ac, roles: { owner, administrator, developer } }),
    consolePlugin(),
  ],
});

export type Auth = typeof auth;
```

- [ ] **Step 5: Re-export for ergonomics**

```ts
// src/auth/index.ts
export { auth, type Auth } from "./auth";
```

- [ ] **Step 6: Generate the better-auth Drizzle schema**

Run: `pnpm auth:generate`
Expected: `src/db/auth-schema.ts` overwritten with `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`, and `installation` table definitions. (Requires a local `.env` with the three required vars so `auth.ts` loads.)

- [ ] **Step 7: Generate the SQL migration**

Run: `pnpm db:generate`
Expected: `src/db/migrations/0000_init.sql` created with `CREATE TABLE` for all tables; a `meta/` journal written.

- [ ] **Step 8: Write the plugin integration test**

```ts
// tests/install-plugin.test.ts
import { describe, it, expect } from "vitest";
import { auth } from "../src/auth";

const headers = { "content-type": "application/json" };
const post = (path: string, body: unknown) =>
  auth.handler(new Request(`http://localhost:3000/api/auth${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }));
const get = (path: string) =>
  auth.handler(new Request(`http://localhost:3000/api/auth${path}`));

describe("console plugin", () => {
  it("reports not installed, then installed after setup", async () => {
    expect(await (await get("/install/status")).json()).toEqual({ installed: false });

    const res = await post("/install/setup", {
      name: "Admin",
      email: "admin@example.com",
      password: "supersecret123",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeTruthy();

    expect(await (await get("/install/status")).json()).toEqual({ installed: true });
  });

  it("rejects a second setup with 409", async () => {
    await post("/install/setup", { name: "A", email: "a@example.com", password: "supersecret123" });
    const res = await post("/install/setup", { name: "B", email: "b@example.com", password: "supersecret123" });
    expect(res.status).toBe(409);
  });

  it("blocks public sign-up", async () => {
    const res = await post("/sign-up/email", { name: "X", email: "x@example.com", password: "supersecret123" });
    expect(res.status).toBe(403);
  });

  it("allows the created admin to sign in", async () => {
    await post("/install/setup", { name: "Admin", email: "admin@example.com", password: "supersecret123" });
    const res = await post("/sign-in/email", { email: "admin@example.com", password: "supersecret123" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeTruthy();
  });
});
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `pnpm vitest run tests/install-plugin.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 10: Typecheck + commit**

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add src/auth/ src/install/status.ts src/db/auth-schema.ts src/db/migrations/ tests/install-plugin.test.ts
git commit -m "feat: add console plugin with install endpoints and signup block"
```

---

## Task 6: HTTP error handling

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
    throw new AppError(409, "not_installed", "Instance is not installed");
  });
  app.get("/oops", () => {
    throw new Error("kaboom");
  });

  it("renders AppError as structured JSON", async () => {
    const res = await app.request("/boom");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "not_installed", message: "Instance is not installed" },
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

## Task 7: Health, me, install-gate; compose the app

**Files:**
- Create: `src/http/health.ts`, `src/http/me.ts`, `src/http/install-gate.ts`, `src/app.ts`
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

  it("gates /api/v1/me to 409 before install", async () => {
    const me = await app.request("/api/v1/me");
    expect(me.status).toBe(409);
    expect((await me.json()).error.code).toBe("not_installed");
  });

  it("install status + setup work through the mounted auth handler", async () => {
    expect(await (await app.request("/api/auth/install/status")).json()).toEqual({ installed: false });
    const setup = await app.request(
      "/api/auth/install/setup",
      json({ name: "Admin", email: "admin@example.com", password: "supersecret123" }),
    );
    expect(setup.status).toBe(200);
    expect(await (await app.request("/api/auth/install/status")).json()).toEqual({ installed: true });
  });

  it("logs in and returns the user from /api/v1/me after install", async () => {
    await app.request(
      "/api/auth/install/setup",
      json({ name: "Admin", email: "admin@example.com", password: "supersecret123" }),
    );
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
import { isInstalled } from "../install/status";
import { AppError } from "./error";

// Applied to /api/v1/*. Returns 409 before install so the UI redirects to setup.
export const installGate = createMiddleware(async (c, next) => {
  if (!(await isInstalled())) {
    throw new AppError(409, "not_installed", "Instance is not installed");
  }
  return next();
});
```

- [ ] **Step 6: Compose the app**

```ts
// src/app.ts
import { Hono } from "hono";
import { auth } from "./auth";
import { onError } from "./http/error";
import { installGate } from "./http/install-gate";
import { health } from "./http/health";
import { me } from "./http/me";

export const app = new Hono();

app.onError(onError);

// Health and better-auth (incl. /api/auth/install/*) are not gated.
app.route("/", health);
app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// Everything under /api/v1 is gated until install completes.
app.use("/api/v1/*", installGate);
app.route("/", me);
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm vitest run tests/app.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Commit**

```bash
git add src/http/ src/app.ts tests/app.test.ts
git commit -m "feat: compose hono app with me, health, and install gate"
```

---

## Task 8: Server entrypoint

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
Expected: logs the listening line. `curl localhost:3000/healthz` → `{"status":"ok"}`; `curl localhost:3000/api/auth/install/status` → `{"installed":false}`.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat: add node server entrypoint"
```

---

## Task 9: Final verification

- [ ] **Step 1: Run the full suite**

Run: `pnpm test`
Expected: all suites green (config, install-plugin, error, app). Requires Docker.

- [ ] **Step 2: Lint + typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: clean. If ESLint is unconfigured, add a minimal flat `eslint.config.js` for TS or set `lint` to `pnpm typecheck` only — do not leave `lint` broken.

- [ ] **Step 3: Confirm contract alignment**

- `pointless.toml [env]` and `.env.example` list the same vars (contract §6). ✓
- No `.env`/secrets committed. ✓
- `installation`, `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation` all present in `src/db/migrations/0000_init.sql`. ✓

- [ ] **Step 4: Commit any fixups**

```bash
git add -A
git commit -m "chore: phase 0 final verification fixups"
```

---

## Definition of done

- `pnpm test` (or `pointless test`) passes: install status transitions, setup happy path + session cookie, second-setup 409, public sign-up blocked (403), login + `/api/v1/me`, install-gate 409-before / pass-after.
- `pnpm lint && pnpm typecheck` clean.
- Manifest and `.env.example` agree on env vars; no secrets in git.
- `installation` + better-auth/organization tables present in the initial migration.
- App boots and serves `/healthz` and `/api/auth/install/status`.

## Notes carried to Phase 1

- Extend `consolePlugin` (or a new `invitePlugin`) so invite acceptance creates users server-side via `internalAdapter` — the `/sign-up/email` block stays in place; invited users never use public sign-up.
- Wire the organization plugin's create/invite/settings endpoints into the product API and enforce the `owner`/`administrator`/`developer` roles from `src/auth/permissions.ts`.
- If the install API surface should live under `/api/v1` for UI consistency, add thin `/api/v1/install/*` Hono routes that proxy to `auth.api.installStatus` / `auth.api.installSetup`.
