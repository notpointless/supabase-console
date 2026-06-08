# supabase-console

Multi-tenant control panel for provisioning and managing Supabase projects on shared local infrastructure or dedicated AWS EC2.

![Dashboard](docs/dashboard.png)

## Features

- **Multi-tenant control plane** — provision and manage many isolated Supabase projects from one dashboard.
- **Your infra, your choice** — run a project on shared local infrastructure or its own dedicated **AWS EC2** instance in your own account.
- **Full project lifecycle** — provision, pause, resume, restart, resize compute & disk, and scheduled logical backups.
- **Deploy from GitHub** — connect a repository and apply your `supabase/migrations` to the database automatically when you push to your production branch.
- **Database branching** — every pull request gets its own isolated preview database, torn down automatically when the PR closes.
- **Custom domains** — point your own domain at a project with automatic HTTPS, plus a built-in connection pooler (dedicated projects).
- **Single sign-on (SAML)** — per-organization SSO against your own identity provider (Okta, Azure AD, Google Workspace).
- **Two-factor authentication** — TOTP MFA for dashboard accounts, with optional per-organization enforcement.
- **Scoped access tokens** — personal API tokens with fine-grained scopes for scripting and automation.
- **Audit logs** — a trail of organization and project activity.
- **Network & transport security** — IP-based network restrictions and enforced SSL on the database.
- **Organizations & roles** — multiple organizations, role-based team access, and per-org AWS credentials + GitHub App.
- **The complete Studio** — table editor, SQL editor, auth, storage, and edge functions, via a forked Supabase Studio.

> Many of these are paid or enterprise-only on Supabase Cloud — here they run on infrastructure you control.

## Installation

This repo is the **control-plane backend** (`:3000`). The dashboard is a
[forked Supabase Studio](https://github.com/notpointless/supabase) (`:8082`) that proxies to it — run both.

Requires Node, pnpm, Docker, and the `pointless` CLI.

```bash
# 1. Backend (this repo)
git clone https://github.com/notpointless/supabase-console.git
cd supabase-console && pnpm install
cp .env.example .env          # fill in the values
pointless run migrate
pointless dev                 # backend on :3000

# 2. Dashboard (the forked Studio — the console-fork branch)
git clone -b chore/console-fork https://github.com/notpointless/supabase.git
cd supabase/apps/studio && pnpm install
# set apps/studio/.env.local: CONSOLE_API_URL=http://localhost:3000, NEXT_PUBLIC_IS_PLATFORM=true
pnpm dev                      # dashboard on :8082
```

Open `http://localhost:8082/dashboard` — it redirects to **/setup/install** to create the first admin.

## Commands

```bash
pointless dev      # run locally with hot reload
pointless test     # run the test suite
pointless lint     # format + lint + typecheck
pointless build    # produce release artifacts
```
