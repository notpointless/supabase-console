# supabase-console

Multi-tenant control panel for provisioning and managing Supabase instances.

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
