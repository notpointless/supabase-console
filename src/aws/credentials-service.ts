import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { orgAwsCredentials } from "../db/schema";
import { encrypt } from "../crypto/secrets";
import { getValidator } from "./credential-validator";

export interface SetCredentialsInput {
  organizationId: string;
  accessKeyId: string;
  secretAccessKey: string;
  defaultRegion: string;
}

export interface CredentialsStatus {
  exists: boolean;
  validated: boolean;
  accountId?: string;
  defaultRegion?: string;
}

export async function setCredentials(input: SetCredentialsInput): Promise<CredentialsStatus> {
  const result = await getValidator().validate({
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
    region: input.defaultRegion,
  });
  if (!result.ok) {
    return { exists: false, validated: false };
  }
  const row = {
    organizationId: input.organizationId,
    accessKeyId: input.accessKeyId,
    secretAccessKeyEncrypted: encrypt(input.secretAccessKey),
    defaultRegion: input.defaultRegion,
    awsAccountId: result.accountId ?? null,
    validatedAt: new Date(),
    updatedAt: new Date(),
  };
  await db
    .insert(orgAwsCredentials)
    .values(row)
    .onConflictDoUpdate({ target: orgAwsCredentials.organizationId, set: row });
  return { exists: true, validated: true, accountId: result.accountId, defaultRegion: input.defaultRegion };
}

export async function getCredentialsStatus(organizationId: string): Promise<CredentialsStatus> {
  const [row] = await db.select().from(orgAwsCredentials).where(eq(orgAwsCredentials.organizationId, organizationId));
  if (!row) return { exists: false, validated: false };
  return {
    exists: true,
    validated: row.validatedAt != null,
    accountId: row.awsAccountId ?? undefined,
    defaultRegion: row.defaultRegion,
  };
}

export async function hasValidCredentials(organizationId: string): Promise<boolean> {
  const [row] = await db.select().from(orgAwsCredentials).where(eq(orgAwsCredentials.organizationId, organizationId));
  return !!row && row.validatedAt != null;
}

export async function deleteCredentials(organizationId: string): Promise<void> {
  await db.delete(orgAwsCredentials).where(eq(orgAwsCredentials.organizationId, organizationId));
}
