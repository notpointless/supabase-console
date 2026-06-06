import { createAuthEndpoint, createAuthMiddleware, APIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { BetterAuthPlugin } from "better-auth";
import { z } from "zod";
import { pool } from "../db/client";
import { isInstalled } from "../install/status";

const INSTALL_LOCK_KEY = 4711;

export const consolePlugin = () => {
  return {
    id: "console",
    schema: {
      installation: {
        fields: {
          installedAt: { type: "date", required: true },
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
          const client = await pool.connect();
          try {
            await client.query("select pg_advisory_lock($1)", [INSTALL_LOCK_KEY]);
            if (await isInstalled()) {
              throw new APIError("CONFLICT", { message: "Instance is already installed" });
            }
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
          matcher: (ctx) => ctx.path === "/sign-up/email",
          handler: createAuthMiddleware(async () => {
            throw new APIError("FORBIDDEN", { message: "Signup is disabled" });
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
};
