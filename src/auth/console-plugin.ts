import { createAuthEndpoint, createAuthMiddleware, APIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { runWithTransaction, getCurrentAdapter } from "@better-auth/core/context";
import type { BetterAuthPlugin } from "better-auth";
import { z } from "zod";
import { pool } from "../db/client";
import { isInstalled } from "../install/status";
import { generateOrgSlug } from "./org-fields";

// Arbitrary app-wide-unique key for the Postgres advisory lock that serializes
// the one-time install setup across concurrent/competing callers.
const INSTALL_LOCK_KEY = 4711;

export const consolePlugin = () => {
  return {
    id: "console",
    schema: {
      installation: {
        fields: {
          installedAt: { type: "date", required: true },
          // Reserved for a future "allow public signup" toggle. Currently UNUSED:
          // the /sign-up/email hook below blocks signups unconditionally (invite-only),
          // and the install setup no longer writes this field. Kept to avoid a
          // schema/migration regeneration; do not rely on it yet.
          allowPublicSignup: { type: "boolean", defaultValue: false },
        },
      },
    },
    endpoints: {
      installStatus: createAuthEndpoint("/install/status", { method: "GET" }, async (ctx) => {
        return ctx.json({ installed: await isInstalled() });
      }),
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
          // Hash before acquiring the lock / opening the transaction: it is pure
          // CPU work that needn't hold a pooled connection or run inside the tx.
          const hash = await ctx.context.password.hash(ctx.body.password);
          const email = ctx.body.email.toLowerCase();
          const name = ctx.body.name;

          const client = await pool.connect();
          try {
            // Non-blocking advisory lock: concurrent callers fast-fail with 409
            // instead of piling up and exhausting the pool waiting on a blocking lock.
            const locked =
              (
                await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [
                  INSTALL_LOCK_KEY,
                ])
              ).rows[0]?.ok === true;
            if (!locked) {
              throw new APIError("CONFLICT", { message: "Install already in progress" });
            }
            if (await isInstalled()) {
              throw new APIError("CONFLICT", { message: "Instance is already installed" });
            }

            // Atomic: createUser + linkAccount + installation marker in ONE DB
            // transaction. runWithTransaction binds the transactional adapter via
            // AsyncLocalStorage, so internalAdapter operations join the same tx.
            // If any step throws, the whole thing rolls back (no half-installed,
            // credential-less admin that would permanently brick the install gate).
            const user = await runWithTransaction(ctx.context.adapter, async () => {
              const created = await ctx.context.internalAdapter.createUser({
                email,
                name,
                role: "admin",
                emailVerified: false,
              });
              await ctx.context.internalAdapter.linkAccount({
                userId: created.id,
                providerId: "credential",
                accountId: created.id,
                password: hash,
              });
              // Use the tx-bound adapter so the marker commits atomically with the user.
              const txAdapter = await getCurrentAdapter(ctx.context.adapter);
              await txAdapter.create({
                model: "installation",
                data: { installedAt: new Date() },
              });
              return created;
            });

            // Cookie/session I/O is intentionally outside the transaction.
            const session = await ctx.context.internalAdapter.createSession(user.id);
            await setSessionCookie(ctx, { session, user });
            return ctx.json({ user });
          } finally {
            // Nested finally guarantees the connection is released even if unlock rejects.
            try {
              await client.query("select pg_advisory_unlock($1)", [INSTALL_LOCK_KEY]);
            } finally {
              client.release();
            }
          }
        },
      ),
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/sign-up/email",
          handler: createAuthMiddleware(async () => {
            throw new APIError("FORBIDDEN", { message: "Signup is disabled" });
          }),
        },
        {
          // Auto-generate a slug for org creation when the client doesn't supply one.
          matcher: (ctx) => ctx.path === "/organization/create",
          handler: createAuthMiddleware(async (ctx) => {
            const body = ctx.body as Record<string, unknown> | undefined;
            if (body && (typeof body.slug !== "string" || body.slug.length === 0)) {
              return { context: { body: { ...body, slug: generateOrgSlug() } } };
            }
            return;
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
};
