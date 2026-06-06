# Vendored: supabase/supabase docker/volumes

**Source:** https://github.com/supabase/supabase/tree/master/docker/volumes  
**Ref:** master  
**Date vendored:** 2026-06-06

## Files

These config files are mounted by `compose.base.yml` at runtime. They are vendored here so
`writeStack()` can copy them into each per-project directory.

| Path | Purpose |
|------|---------|
| `api/kong.yml` | Kong declarative config (API gateway routes, consumers, ACLs) |
| `api/kong-entrypoint.sh` | Kong container entrypoint — substitutes env vars into kong.yml |
| `db/_supabase.sql` | Init migration: internal supabase schema |
| `db/jwt.sql` | Init script: sets JWT_SECRET + JWT_EXP in pg settings |
| `db/logs.sql` | Init migration: Analytics/_analytics support |
| `db/pooler.sql` | Init migration: Supavisor/pooler support |
| `db/realtime.sql` | Init migration: Realtime schema |
| `db/roles.sql` | Init script: PostgreSQL role configuration |
| `db/webhooks.sql` | Init script: webhook trigger functions |
| `db/init/data.sql` | Optional seed data |
| `functions/main/index.ts` | Edge Runtime main relay function |
| `functions/hello/index.ts` | Example Edge Function |
| `pooler/pooler.exs` | Supavisor Elixir config |
| `logs/vector.yml` | Vector log aggregator config |
| `snippets/.gitkeep` | Placeholder — Studio snippets mount point |
| `storage/.gitkeep` | Placeholder — Storage API file backend mount point |

## Update procedure

Re-run the download script or fetch from:
`https://raw.githubusercontent.com/supabase/supabase/master/docker/volumes/<path>`

**Do not hand-edit these files** — they are overwritten on vendor updates.
