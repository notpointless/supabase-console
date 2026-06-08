# supabase-console

Multi-tenant control panel for provisioning and managing Supabase projects on your own AWS account.

![Dashboard](docs/dashboard.png)

## Features

- **Multi-tenant** — provision and manage many Supabase projects from one dashboard.
- **Shared or dedicated** — run a project on shared infrastructure or its own dedicated AWS EC2 instance.
- **Dedicated extras** — resize compute and disk, custom domains with automatic HTTPS, and a connection pooler.
- **Security & org** — SSO, MFA, audit logs, scoped access tokens, and per-organization AWS credentials.

## Installation

Requires Node, pnpm, Docker, and the `pointless` CLI.

```bash
git clone https://github.com/notpointless/supabase-console.git
cd supabase-console
pnpm install
cp .env.example .env       # then fill in the values
pointless run migrate      # set up the database
pointless dev              # start the console
```

Then POST to `/api/auth/install/setup` to create the first admin.

## Commands

```bash
pointless dev      # run locally with hot reload
pointless test     # run the test suite
pointless lint     # format + lint + typecheck
pointless build    # produce release artifacts
```
