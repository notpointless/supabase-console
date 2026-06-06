import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization } from "better-auth/plugins";
import { db } from "../db/client";
import { getEnv } from "../config/env";
import { ac, owner, administrator, developer } from "./permissions";
import { consolePlugin } from "./console-plugin";

const env = getEnv();

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.BETTER_AUTH_URL],
  database: drizzleAdapter(db, { provider: "pg" }),
  emailAndPassword: { enabled: true },
  plugins: [
    admin(),
    organization({ ac, roles: { owner, administrator, developer } }),
    consolePlugin(),
  ],
});

export type Auth = typeof auth;
