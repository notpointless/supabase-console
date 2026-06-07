import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization, twoFactor, oidcProvider } from "better-auth/plugins";
import { sso } from "@better-auth/sso";
import { apiKey } from "@better-auth/api-key";
import { db } from "../db/client";
import { getEnv } from "../config/env";
import { ac, owner, administrator, developer } from "./permissions";
import { consolePlugin } from "./console-plugin";
import { assertValidOrgFields } from "./org-fields";
import { getMailer } from "../email/mailer";

const env = getEnv();

export const auth = betterAuth({
  appName: "Supabase Console",
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  // Trust the dashboard origin (APP_URL) too: the forked Studio proxies
  // /api/auth/* from its own origin, so requests carry that Origin header.
  trustedOrigins: [env.BETTER_AUTH_URL, ...(env.APP_URL ? [env.APP_URL] : [])],
  // `transaction: true` lets better-auth wrap multi-step writes (e.g. the
  // install setup createUser + linkAccount + marker) in a real DB transaction.
  database: drizzleAdapter(db, { provider: "pg", transaction: true }),
  emailAndPassword: {
    enabled: true,
    // [console fork] Self-host policy: no public self-serve sign-up. Admins are
    // created during install / via invite, never through an open sign-up endpoint.
    disableSignUp: true,
  },
  user: {
    additionalFields: {
      firstName: { type: "string", input: true, required: false },
      lastName: { type: "string", input: true, required: false },
      username: { type: "string", input: true, required: false },
    },
  },
  // Namespace our cookies (default prefix is "better-auth"). The session cookie
  // and the cookie-cache cookie get explicit product names.
  advanced: {
    cookiePrefix: "supabase-console",
    cookies: {
      session_token: { name: "supabase-console.session" },
      session_data: { name: "supabase-console.session-data" },
    },
  },
  plugins: [
    admin(),
    organization({
      ac,
      roles: { owner, administrator, developer },
      creatorRole: "owner",
      allowUserToCreateOrganization: true,
      requireEmailVerificationOnInvitation: false,
      schema: {
        organization: {
          additionalFields: {
            type: { type: "string", input: true, required: false, defaultValue: "personal" },
            dataPrivacyLevel: {
              type: "string",
              input: true,
              required: false,
              defaultValue: "disabled",
            },
            mfaRequired: { type: "boolean", input: true, required: false, defaultValue: false },
          },
        },
      },
      organizationHooks: {
        beforeCreateOrganization: async ({ organization }) => {
          assertValidOrgFields(organization as { type?: unknown; dataPrivacyLevel?: unknown });
          return { data: organization };
        },
        beforeUpdateOrganization: async ({ organization }) => {
          assertValidOrgFields(organization as { type?: unknown; dataPrivacyLevel?: unknown });
          return { data: organization };
        },
      },
      sendInvitationEmail: async (data) => {
        const base = env.APP_URL ?? env.BETTER_AUTH_URL;
        await getMailer().sendInvite({
          to: data.email,
          acceptUrl: `${base}/accept-invite?invitationId=${data.id}`,
          organizationName: data.organization.name,
          role: Array.isArray(data.role) ? data.role.join(",") : String(data.role),
          inviterEmail: data.inviter?.user?.email,
        });
      },
    }),
    sso({
      organizationProvisioning: {
        disabled: false,
        // Type only allows "member"|"admin"; cast to pass our custom role string.
        defaultRole: "developer" as "member",
      },
    }),
    twoFactor(),
    // Makes the console an OIDC provider so orgs can publish OAuth apps.
    // loginPage is where the provider redirects unauthenticated users mid-flow.
    oidcProvider({ loginPage: "/sign-in" }),
    // Personal Access Tokens for /api/v1 auth (user-owned, metadata-enabled,
    // default prefix "sbp_" — Supabase-style). Single default config.
    apiKey({ enableMetadata: true, defaultPrefix: "sbp_" }),
    consolePlugin(),
  ],
});

export type Auth = typeof auth;
