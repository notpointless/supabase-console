import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization } from "better-auth/plugins";
import { sso } from "@better-auth/sso";
import { db } from "../db/client";
import { getEnv } from "../config/env";
import { ac, owner, administrator, developer } from "./permissions";
import { consolePlugin } from "./console-plugin";
import { assertValidOrgFields } from "./org-fields";
import { getMailer } from "../email/mailer";

const env = getEnv();

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.BETTER_AUTH_URL],
  // `transaction: true` lets better-auth wrap multi-step writes (e.g. the
  // install setup createUser + linkAccount + marker) in a real DB transaction.
  database: drizzleAdapter(db, { provider: "pg", transaction: true }),
  emailAndPassword: { enabled: true },
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
    consolePlugin(),
  ],
});

export type Auth = typeof auth;
