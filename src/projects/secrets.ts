import { randomBytes, createHmac } from "node:crypto";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { projectSecrets } from "../db/schema";
import { encrypt, decrypt } from "../crypto/secrets";

export interface ProjectSecretValues {
  jwtSecret: string;
  anonKey: string;
  serviceRoleKey: string;
  secretKeyBase: string;
  dashboardPassword: string;
  vaultEncKey: string;
  pgMetaCryptoKey: string;
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

// [console fork] New-format API keys (sb_publishable_* / sb_secret_*). Derived
// deterministically from the project's JWT secret so they need no extra storage and
// are reproducible in buildStack (kong accepts them via SUPABASE_PUBLISHABLE_KEY /
// SUPABASE_SECRET_KEY keyauth credentials). Rotating the JWT secret rotates these.
export function derivePublishableKey(jwtSecret: string): string {
  const sig = createHmac("sha256", jwtSecret).update("sb_publishable_v1").digest("hex").slice(0, 40);
  return `sb_publishable_${sig}`;
}

export function deriveSecretKey(jwtSecret: string): string {
  const sig = createHmac("sha256", jwtSecret).update("sb_secret_v1").digest("hex").slice(0, 40);
  return `sb_secret_${sig}`;
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
    // 32 hex chars (16 bytes) — Supabase Vault requires a 32-character key
    vaultEncKey: randomBytes(16).toString("hex"),
    pgMetaCryptoKey: randomBytes(16).toString("hex"),
  };
}

/** Single source of truth for mapping ProjectSecretValues → encrypted DB columns. */
export function encryptedSecretColumns(projectId: string, v: ProjectSecretValues) {
  return {
    projectId,
    jwtSecretEncrypted: encrypt(v.jwtSecret),
    anonKeyEncrypted: encrypt(v.anonKey),
    serviceRoleKeyEncrypted: encrypt(v.serviceRoleKey),
    secretKeyBaseEncrypted: encrypt(v.secretKeyBase),
    dashboardPasswordEncrypted: encrypt(v.dashboardPassword),
    vaultEncKeyEncrypted: encrypt(v.vaultEncKey),
    pgMetaCryptoKeyEncrypted: encrypt(v.pgMetaCryptoKey),
  };
}

export async function storeProjectSecrets(projectId: string, v: ProjectSecretValues): Promise<void> {
  await db.insert(projectSecrets).values(encryptedSecretColumns(projectId, v));
}

export async function getProjectSecrets(projectId: string): Promise<ProjectSecretValues | undefined> {
  const [row] = await db.select().from(projectSecrets).where(eq(projectSecrets.projectId, projectId));
  if (!row) return undefined;
  return {
    jwtSecret: decrypt(row.jwtSecretEncrypted),
    anonKey: decrypt(row.anonKeyEncrypted),
    serviceRoleKey: decrypt(row.serviceRoleKeyEncrypted),
    secretKeyBase: decrypt(row.secretKeyBaseEncrypted),
    dashboardPassword: decrypt(row.dashboardPasswordEncrypted),
    vaultEncKey: decrypt(row.vaultEncKeyEncrypted),
    pgMetaCryptoKey: decrypt(row.pgMetaCryptoKeyEncrypted),
  };
}
