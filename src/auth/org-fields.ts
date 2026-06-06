import { randomInt } from "node:crypto";
import { APIError } from "better-auth/api";

// "na" is the stored token for the "N/A" option (informational only).
export const ORG_TYPES = ["personal", "educational", "startup", "agency", "company", "na"] as const;
export type OrgType = (typeof ORG_TYPES)[number];

export const DATA_PRIVACY_LEVELS = [
  "disabled",
  "schema",
  "schema_and_logs",
  "schema_logs_and_data",
] as const;
export type DataPrivacyLevel = (typeof DATA_PRIVACY_LEVELS)[number];

export function isOrgType(v: unknown): v is OrgType {
  return typeof v === "string" && (ORG_TYPES as readonly string[]).includes(v);
}

export function isDataPrivacyLevel(v: unknown): v is DataPrivacyLevel {
  return typeof v === "string" && (DATA_PRIVACY_LEVELS as readonly string[]).includes(v);
}

// Supabase-style slug: 20 random lowercase letters.
export function generateOrgSlug(): string {
  let s = "";
  for (let i = 0; i < 20; i++) s += String.fromCharCode(97 + randomInt(26));
  return s;
}

// Throws on invalid enum values; ignores fields that aren't present (partial updates).
export function assertValidOrgFields(input: { type?: unknown; dataPrivacyLevel?: unknown }): void {
  if (input.type !== undefined && !isOrgType(input.type)) {
    throw new APIError("BAD_REQUEST", { message: "Invalid organization type" });
  }
  if (input.dataPrivacyLevel !== undefined && !isDataPrivacyLevel(input.dataPrivacyLevel)) {
    throw new APIError("BAD_REQUEST", { message: "Invalid data privacy level" });
  }
}
