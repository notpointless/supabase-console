import { randomBytes, createHmac, createHash, createECDH } from "node:crypto";
import { SignJWT, importJWK } from "jose";
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

const b64url = (b: Buffer): string => b.toString("base64url");

/**
 * [console fork] Asymmetric (ES256) JWT signing keys, derived deterministically from
 * the project's JWT secret — no extra storage, reproducible in buildStack.
 *
 * Returns everything the stack needs to run on signing keys WITHOUT breaking legacy
 * HS256 tokens:
 *  - jwtKeys: GoTrue GOTRUE_JWT_KEYS (the EC private JWK) so it can sign asymmetric.
 *  - jwtJwks: a JWKS containing the EC PUBLIC key AND the legacy HS256 symmetric key,
 *    so every service (rest/storage/realtime/…) validates BOTH old and new tokens.
 *  - anonAsymmetric / serviceAsymmetric: ES256-signed anon/service_role JWTs that
 *    kong injects when an sb_ opaque key is presented.
 */
export async function deriveSigningKeys(jwtSecret: string): Promise<{
  jwtKeys: string;
  jwtJwks: string;
  anonAsymmetric: string;
  serviceAsymmetric: string;
}> {
  // Deterministic P-256 private scalar from the project secret.
  const d = createHash("sha256").update(`${jwtSecret}:es256-signing-v1`).digest();
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey(); // 0x04 || X(32) || Y(32)
  const x = b64url(pub.subarray(1, 33));
  const y = b64url(pub.subarray(33, 65));
  const kid = createHash("sha256").update(pub).digest("hex").slice(0, 16);

  // GoTrue detects the signing key by key_ops containing "sign"; verification-only
  // keys use ["verify"]. (use:"sig" alone is not enough for GoTrue.)
  const privateJwk = {
    kty: "EC",
    crv: "P-256",
    d: b64url(d),
    x,
    y,
    alg: "ES256",
    use: "sig",
    kid,
    key_ops: ["sign", "verify"],
  };
  const publicJwk = {
    kty: "EC",
    crv: "P-256",
    x,
    y,
    alg: "ES256",
    use: "sig",
    kid,
    key_ops: ["verify"],
  };
  // Legacy HS256 key: the anon/service JWTs are signed over the UTF-8 bytes of the
  // secret string, so the oct key material is those bytes (not decoded).
  const legacyJwk = {
    kty: "oct",
    k: b64url(Buffer.from(jwtSecret, "utf8")),
    alg: "HS256",
    use: "sig",
    kid: "legacy-hs256",
    key_ops: ["verify"],
  };

  const ecKey = await importJWK(privateJwk, "ES256");
  const iat = Math.floor(Date.now() / 1000);
  const signAsym = (role: "anon" | "service_role") =>
    new SignJWT({ role, iss: "supabase" })
      .setProtectedHeader({ alg: "ES256", typ: "JWT", kid })
      .setIssuedAt(iat)
      .setExpirationTime(iat + TEN_YEARS_SECONDS)
      .sign(ecKey);

  const [anonAsymmetric, serviceAsymmetric] = await Promise.all([
    signAsym("anon"),
    signAsym("service_role"),
  ]);

  return {
    jwtKeys: JSON.stringify([privateJwk]),
    jwtJwks: JSON.stringify({ keys: [publicJwk, legacyJwk] }),
    anonAsymmetric,
    serviceAsymmetric,
  };
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
