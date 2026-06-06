import { randomBytes } from "node:crypto";
import { SignJWT } from "jose";

export interface ProjectSecretValues {
  jwtSecret: string;
  anonKey: string;
  serviceRoleKey: string;
  secretKeyBase: string;
  dashboardPassword: string;
}

const TEN_YEARS_SECONDS = 60 * 60 * 24 * 365 * 10;

export async function signSupabaseKey(
  jwtSecret: string,
  role: "anon" | "service_role",
): Promise<string> {
  const secret = new TextEncoder().encode(jwtSecret);
  const iat = Math.floor(Date.now() / 1000);
  return new SignJWT({ role, iss: "supabase" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(iat)
    .setExpirationTime(iat + TEN_YEARS_SECONDS)
    .sign(secret);
}

export async function generateProjectSecrets(): Promise<ProjectSecretValues> {
  const jwtSecret = randomBytes(32).toString("base64url");
  const [anonKey, serviceRoleKey] = await Promise.all([
    signSupabaseKey(jwtSecret, "anon"),
    signSupabaseKey(jwtSecret, "service_role"),
  ]);
  return {
    jwtSecret,
    anonKey,
    serviceRoleKey,
    secretKeyBase: randomBytes(32).toString("hex"),
    dashboardPassword: randomBytes(18).toString("base64url"),
  };
}
