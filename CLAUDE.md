# supabase-console — repo-specific notes

Phase 0 = foundations & install. See docs/superpowers/specs/ and docs/superpowers/plans/.
Control plane = Node service (Hono + Drizzle + Postgres + better-auth). API-first; UI is Phase 4.
Install + invite-only identity is a custom better-auth plugin (src/auth/console-plugin.ts).
Follows the Pointless AI org contract (../CLAUDE.md). The .pointless/CLAUDE.base.md import will be
added once the pointless CLI scaffolds it.
