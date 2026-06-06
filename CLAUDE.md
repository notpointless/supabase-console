# supabase-console — repo-specific notes

Phase 0 = foundations & install. See docs/superpowers/specs/ and docs/superpowers/plans/.
Control plane = Node service (Hono + Drizzle + Postgres + better-auth). API-first; UI is Phase 4.
Install + invite-only identity is a custom better-auth plugin (src/auth/console-plugin.ts).
Follows the Pointless AI org contract (../CLAUDE.md). The .pointless/CLAUDE.base.md import will be
added once the pointless CLI scaffolds it.

## Version coupling: better-auth + @better-auth/core

`better-auth`, `@better-auth/core`, and the `better-call` override in `pnpm-workspace.yaml` are
version-coupled and pinned exact — bump them together. The exact pins exist so the app shares
better-auth's AsyncLocalStorage instance for the transactional install plugin
(`runWithTransaction` / `getCurrentAdapter`). Two separate resolved copies of `@better-auth/core`
would silently lose ALS context across install steps. These pins can be relaxed once
`@better-auth/cli` catches up to the better-auth runtime line.
