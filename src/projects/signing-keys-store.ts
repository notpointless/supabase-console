import { generateKeyPairSync, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getEnv } from "../config/env";

type Jwk = Record<string, unknown> & { kid?: string; x?: unknown; y?: unknown; d?: unknown };

// [console fork] Standby JWT signing keys created via the dashboard. The project's
// "current" ES256 key is derived from its JWT secret (see secrets.ts); these are
// ADDITIONAL keys an operator adds for rotation. Stored per-project as JSON. Each is
// included in the stack's JWKS (so all services verify tokens it signs) and in
// GOTRUE_JWT_KEYS; status controls whether GoTrue signs with it.

export interface StandbyKey {
  kid: string;
  algorithm: "ES256";
  status: "standby" | "in_use" | "previously_used" | "revoked";
  created_at: string;
  privateJwk: Jwk;
  publicJwk: Jwk;
}

function dir(): string {
  return join(getEnv().DATA_DIR, "signing-keys");
}
function pathFor(ref: string): string {
  return join(dir(), `${ref}.json`);
}

export function readStandbyKeys(ref: string): StandbyKey[] {
  try {
    return JSON.parse(readFileSync(pathFor(ref), "utf8"));
  } catch {
    return [];
  }
}

function write(ref: string, keys: StandbyKey[]): void {
  if (!existsSync(dir())) mkdirSync(dir(), { recursive: true });
  writeFileSync(pathFor(ref), JSON.stringify(keys, null, 2), "utf8");
}

export function generateStandbyKey(): StandbyKey {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const priv = privateKey.export({ format: "jwk" }) as Jwk;
  const { d: _d, ...pubFields } = priv;
  const kid = createHash("sha256")
    .update(`${pubFields.x}.${pubFields.y}`)
    .digest("hex")
    .slice(0, 16);
  return {
    kid,
    algorithm: "ES256",
    status: "standby",
    created_at: new Date().toISOString(),
    privateJwk: { ...priv, alg: "ES256", use: "sig", kid, key_ops: ["verify"] } as any,
    publicJwk: { ...pubFields, alg: "ES256", use: "sig", kid, key_ops: ["verify"] } as any,
  };
}

export function addStandbyKey(ref: string): StandbyKey {
  const keys = readStandbyKeys(ref);
  const key = generateStandbyKey();
  keys.push(key);
  write(ref, keys);
  return key;
}

export function removeStandbyKey(ref: string, kid: string): void {
  write(
    ref,
    readStandbyKeys(ref).filter((k) => k.kid !== kid)
  );
}

export function setStandbyKeyStatus(ref: string, kid: string, status: StandbyKey["status"]): boolean {
  const keys = readStandbyKeys(ref);
  const key = keys.find((k) => k.kid === kid);
  if (!key) return false;
  key.status = status;
  // GoTrue signs only with a key whose key_ops include "sign".
  key.privateJwk.key_ops = status === "in_use" ? ["sign", "verify"] : ["verify"];
  write(ref, keys);
  return true;
}
