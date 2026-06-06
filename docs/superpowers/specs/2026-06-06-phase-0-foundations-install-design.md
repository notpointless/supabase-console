# Phase 0 — Foundations & Install (Design Spec)

**Date:** 2026-06-06
**Repo:** `supabase-console` (Pointless AI org)
**Status:** Approved design — ready for implementation plan

---

## 0. Context

`supabase-console` is a **multi-tenant control plane for provisioning and managing Supabase
instances** on shared infrastructure or dedicated EC2 — conceptually a self-hosted rebuild of
Supabase's own platform/management layer. The full product decomposes into independent phases,
each with its own spec → plan → build cycle:

- **Phase 0 — Foundations & Install** ← *this spec*
- **Phase 1 — Tenancy API** (organizations, members, roles, invites, org settings)
- **Phase 2 — Project model + provisioning abstraction** (project lifecycle, region/capability
  model, EC2-credential detection, a provisioner interface with a stub backend)
- **Phase 3 — Real provisioning engine** (shared-infra multi-tenancy, then dedicated EC2:
  launch instance → install Supabase stack → routing/DNS → per-project secrets/keys; pause/resume/delete)
- **Phase 4 — UI** (the dashboard, **reusing `supabase/supabase`'s existing components**, built last)

Out of scope for the whole product (per stakeholder direction): billing/billing-cycles, plan
gating (nothing is gated), legal-documents section. GitHub/Vercel integrations and usage metrics
are optional add-ons after the core works.

**This spec covers Phase 0 only:** the runnable skeleton plus identity — repo scaffold to the org
contract, datastore, console authentication, first-run install/admin bootstrap, and the session
model.

---

## 1. Foundational decisions (made during brainstorming)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Control-plane runtime | **Node service on a server** (Fly/EC2) | Phase 3 needs real long-running orchestration (Docker socket, AWS SDK, multi-minute installs) — Workers can't hold a process open. Diverges from the contract's *example* `cloudflare` target, which is illustrative, not binding. |
| Datastore | **Postgres** via **Drizzle** | Obvious fit for a Supabase-shop; TS-first, strict-mode friendly. |
| HTTP layer | **Hono** + **Zod** | Lightweight, runs on Node, easy in-process testing. |
| Auth | **better-auth** | Email/password + httpOnly sessions out of the box; its `organization` plugin maps ~1:1 onto Phase 1 (orgs/members/roles/invitations); `admin` plugin enables server-side user creation. |
| Registration model | **Invite-only** | Private self-hosted control plane. No public `/sign-up`. First admin created at install; everyone else joins via org invitation (Phase 1). |
| Package manager / TS | **pnpm**, **TS strict** | Contract §8 `ts-node` addendum. |

---

## 2. Scope of Phase 0

**In scope**
- Repo scaffolded to org contract §2 (manifest, layout, env, README).
- Postgres + Drizzle wiring and initial migration.
- better-auth instance configured: email/password with **public sign-up disabled**, `admin`
  plugin, `organization` plugin **registered** (so its tables ship in the first migration).
- Owner / Administrator / Developer access-control roles **defined** (enforced in Phase 1).
- First-run install flow: `/install/setup` creates the first admin and an installation marker.
- Session model (httpOnly cookie) and `/api/v1/me`.
- Install-gate middleware and a consistent JSON error shape.
- Integration tests against a throwaway Postgres.

**Explicitly out of scope (deferred to later phases)**
- Organization create/invite/settings *behavior* (Phase 1) — only the *schema* lands now.
- Projects, regions, provisioning, EC2 (Phase 2/3).
- Any UI (Phase 4). Phase 0 is API-only.
- Email/SMTP delivery for invitations (Phase 1).
- Deployment of the Node service (`[deploy].target = "none"` for now).

**Why register the organization plugin now but not build its flows:** better-auth's organization
plugin owns several tables (`organization`, `member`, `invitation`) and augments the session with
an active organization. Registering it in Phase 0 means those tables ship in the initial migration,
avoiding a disruptive re-migration when Phase 1 begins. The endpoints it exposes are simply not
wired into our `/api/v1` surface or tested until Phase 1.

---

## 3. Architecture & components

Each `src/` subfolder is one unit with a single purpose, a well-defined interface, and clear
dependencies — understandable and testable in isolation.

- **`src/config`** — Zod-validated environment loader. Reads `process.env`, validates, and exports
  a typed `Config`. Throws a clear error listing any missing **required** vars on boot.
  *Depends on:* nothing. *Used by:* everything.

- **`src/db`** — Drizzle Postgres client (`client.ts`), our hand-authored schema (`schema.ts`,
  currently just the `installation` table), and generated SQL migrations (`migrations/`).
  *Depends on:* `config` (for `DATABASE_URL`). *Used by:* `auth`, `install`.

- **`src/auth`** — the better-auth instance (`auth.ts`) and the access-control role definitions
  (`permissions.ts`). Configures `emailAndPassword` (sign-up disabled), the `admin` plugin, the
  `organization` plugin (with our custom roles), and the Drizzle adapter (`provider: "pg"`).
  Exposes the `auth` object (whose `.handler` mounts under `/api/auth/*`, and whose `.api.*`
  server methods the install service calls). *Depends on:* `db`, `config`. *Used by:* `http`, `install`.

- **`src/install`** — installation service (`service.ts`) and routes (`routes.ts`).
  `isInstalled()` returns whether the installation marker row exists; `setup({name,email,password})`
  re-checks not-installed, creates the first user via `auth.api.createUser` with admin role, writes
  the marker, and returns a session (auto-login). *Depends on:* `db`, `auth`. *Used by:* `http`.

- **`src/http`** — Hono composition helpers: shared error handler (`error.ts`), install-gate
  middleware (`install-gate.ts`), `me.ts` (`GET /api/v1/me`), `health.ts` (`GET /healthz`).
  *Depends on:* `auth`, `install`. *Used by:* `app.ts`.

- **`src/app.ts`** — builds and returns the configured Hono app (mounts better-auth, install
  routes, me, health; attaches error handler + install-gate). **No port binding** — imported
  directly by tests. *Depends on:* all of the above.

- **`src/server.ts`** — entrypoint. Wires `config → db → app` and calls `listen(PORT)`. The only
  module that binds a port. Dev runs it under `tsx watch`.

---

## 4. Data model

Created in Phase 0's initial migration:

| Table | Source | Notes |
|-------|--------|-------|
| `user` | better-auth core | identity; admin plugin adds `role`/`banned` fields |
| `session` | better-auth core | httpOnly cookie sessions; organization plugin adds active-org |
| `account` | better-auth core | credential (password hash) linkage |
| `verification` | better-auth core | token verification |
| `organization` | organization plugin | **schema only** in Phase 0; flows in Phase 1 |
| `member` | organization plugin | **schema only** in Phase 0 |
| `invitation` | organization plugin | **schema only** in Phase 0 |
| `installation` | **ours** (`schema.ts`) | single-row marker: `id`, `installed_at`, room for future instance settings (e.g. `allow_public_signup` default `false`) |

better-auth's tables are produced via its schema generator (`better-auth` CLI `generate`) into the
Drizzle schema, then materialized as SQL by `drizzle-kit generate`. Only `installation` is
hand-authored in `schema.ts`. The implementation plan will spell out this generation step.

### Roles

Defined in `src/auth/permissions.ts` via better-auth's `createAccessControl`, mapping the three
roles the product UI shows onto a permission statement over resources (`organization`, `project`,
`member`, …):

- **Owner** — full access, including deleting the organization and transferring/deleting projects.
- **Administrator** — manage members, billing*, and project settings, including deleting projects;
  cannot manage organization settings or owners. *(*billing is not implemented; the permission slot
  exists for parity but maps to nothing in this product.)*
- **Developer** — manage project content (data, users, files, edge functions); cannot change
  settings or delete projects.

Roles are **defined** now and **enforced** in Phase 1. The first admin created at install holds
the platform `admin` role (admin plugin), distinct from these per-organization roles.

---

## 5. Install + auth flow

1. Fresh boot, no installation marker → `GET /api/v1/install/status` returns `{ installed: false }`.
2. `POST /api/v1/install/setup { name, email, password }`:
   - Server re-checks `isInstalled()` (defends against a race / replay).
   - Creates the first user via `auth.api.createUser` with admin role.
   - Writes the `installation` marker row.
   - Returns a session (sets the httpOnly cookie — admin is logged in immediately).
3. Any subsequent `POST /api/v1/install/setup` → **409 Conflict** (`already_installed`).
4. Thereafter, login via `POST /api/auth/sign-in/email`. Public sign-up is **disabled** —
   `POST /api/auth/sign-up/email` is rejected by better-auth.
5. **Install-gate middleware:** before installation, any `/api/v1/*` request other than the install
   routes returns **409** (`not_installed`) so the future UI knows to redirect to `/install/setup`.
   `/healthz` and `/api/auth/*` are exempt.

**Security note:** `setup` is authorized *solely* by the absence of an installation marker — there
is no other gate, so the marker write and the not-installed check must be correct and atomic. The
plan will treat this as the critical security boundary of Phase 0.

---

## 6. API surface (Phase 0)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/healthz` | liveness; no auth, no install gate |
| GET | `/api/v1/install/status` | `{ installed: boolean }` |
| POST | `/api/v1/install/setup` | create first admin (only when not installed; else 409) |
| ALL | `/api/auth/*` | better-auth handler (sign-in/email, sign-out, get-session, …) |
| GET | `/api/v1/me` | current user/session; 401 if unauthenticated |

---

## 7. Error handling

`/api/v1` responses use a consistent JSON shape:

```json
{ "error": { "code": "string", "message": "human readable", "details": {} } }
```

- Zod validation failure → **400** (`validation_error`, `details` = field issues).
- Unauthenticated on a protected route → **401** (`unauthenticated`).
- Install-gate / already-installed → **409** (`not_installed` / `already_installed`).
- Unhandled → **500** (`internal_error`, no internals leaked).

better-auth owns its own response shapes under `/api/auth/*`; we do not rewrap those.

---

## 8. Testing

**Vitest.** Integration tests import `app.ts` and run the Hono app in-process against a throwaway
**Postgres via Testcontainers**, migrated fresh per run. This is the only network dependency and is
declared per contract §4 ("no network unless declared").

Cases:
- `install.test.ts` — status `false` → `true` transition; setup happy path returns a session;
  second setup → 409.
- `auth.test.ts` — public sign-up rejected; login succeeds; `/api/v1/me` returns the user when
  authenticated and 401 when not.
- `install-gate.test.ts` — `/api/v1/me` returns 409 before install, succeeds after; `/healthz` and
  `/api/auth/*` exempt.

Helpers: `tests/helpers/test-db.ts` (container + migrate), `tests/helpers/test-app.ts` (build app
against the test DB).

---

## 9. Manifest & environment

**`pointless.toml`**

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
deploy = "true"            # no-op for now; target = none

[commands.run]
migrate = "pnpm migrate"   # drizzle-kit migrate — invoked via `pointless run migrate`

[env]
required = ["DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"]
optional = ["PORT", "LOG_LEVEL"]

[deploy]
target = "none"
```

> The exact manifest encoding for custom verbs (`[commands.run]` vs another form) will be confirmed
> against the `pointless` CLI when scaffolding; the intent is a `migrate` verb callable as
> `pointless run migrate`.

**`.env.example`** mirrors `[env]` with placeholders:

```
DATABASE_URL=postgres://postgres:postgres@localhost:5432/supabase_console
BETTER_AUTH_SECRET=replace-with-a-long-random-string
BETTER_AUTH_URL=http://localhost:3000
PORT=3000
LOG_LEVEL=info
```

No secrets in git (contract §6) — `.env` is git-ignored; placeholders only.

---

## 10. Folder structure

```
supabase-console/
├── pointless.toml                 # manifest (§3): type=app, stack=ts-node
├── CLAUDE.md                      # thin: @import .pointless/CLAUDE.base.md + repo notes
├── .pointless/
│   └── CLAUDE.base.md             # CLI-managed, do not edit
├── README.md                      # starts with `pointless` usage
├── .env.example
├── .gitignore
├── package.json                   # pnpm scripts the manifest maps to
├── pnpm-lock.yaml
├── tsconfig.json                  # strict
├── drizzle.config.ts              # schema path + migrations dir + DATABASE_URL
├── vitest.config.ts
│
├── src/
│   ├── server.ts                  # entrypoint: config -> db -> app -> listen
│   ├── app.ts                     # builds & returns the Hono app (no listen)
│   │
│   ├── config/
│   │   ├── env.ts                 # Zod-validated env loader
│   │   └── index.ts
│   │
│   ├── db/
│   │   ├── client.ts              # drizzle(pg) client
│   │   ├── schema.ts              # installation table (+ re-exports auth tables)
│   │   └── migrations/
│   │       └── 0000_init.sql
│   │
│   ├── auth/
│   │   ├── auth.ts                # betterAuth({...}) + drizzleAdapter(pg)
│   │   ├── permissions.ts         # createAccessControl + Owner/Administrator/Developer
│   │   └── index.ts
│   │
│   ├── install/
│   │   ├── service.ts             # isInstalled(), setup(...)
│   │   └── routes.ts              # GET /install/status, POST /install/setup
│   │
│   └── http/
│       ├── error.ts               # shared error handler
│       ├── install-gate.ts        # middleware: 409 on /api/v1/* before install
│       ├── me.ts                  # GET /api/v1/me
│       └── health.ts              # GET /healthz
│
└── tests/
    ├── helpers/
    │   ├── test-db.ts             # Testcontainers Postgres + migrate
    │   └── test-app.ts            # builds app against the test db
    ├── install.test.ts
    ├── auth.test.ts
    └── install-gate.test.ts
```

**Notes:**
- **`app.ts` / `server.ts` split** keeps integration tests fast and network-free except the
  declared test DB.
- better-auth tables are **generated** into the migration, not hand-written; only `installation`
  is hand-authored in `schema.ts`.
- Routes are colocated with their feature and composed in `app.ts` — no single mega-router — so
  each unit stays small and independently readable.

---

## 11. Definition of done (Phase 0)

- `pointless lint` and `pointless test` pass (real output, contract §9.7).
- Fresh DB → `install/status` reports `false`; `setup` creates an admin and flips it to `true`;
  a second `setup` is rejected with 409.
- Public sign-up is rejected; the created admin can log in and `/api/v1/me` returns them.
- Install-gate behaves as specified.
- Manifest and `.env.example` agree on env vars (contract §6).
- The better-auth `organization` schema is present in the initial migration (unused until Phase 1).
```