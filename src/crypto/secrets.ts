import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getEnv } from "../config/env";

function key(): Buffer {
  return Buffer.from(getEnv().ENCRYPTION_KEY, "hex"); // 64 hex chars = 32 bytes
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(":");
  const [ivb, tagb, ctb] = parts;
  if (parts.length !== 3 || !ivb || !tagb || !ctb) throw new Error("Invalid ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivb, "base64"));
  decipher.setAuthTag(Buffer.from(tagb, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctb, "base64")), decipher.final()]).toString("utf8");
}
