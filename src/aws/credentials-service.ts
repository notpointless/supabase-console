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

export interface SetCredentialsResult {
  validated: boolean;
  accountId?: string;
  defaultRegion?: string;
}

export interface CredentialsStatus {
  exists: boolean;
  validated: boolean;
  accountId?: string;
  defaultRegion?: string;
}

export async function setCredentials(input: SetCredentialsInput): Promise<SetCredentialsResult> {
  const result = await getValidator().validate({
    accessKeyId: input.accessKeyId,
    secretAccessKey: input.secretAccessKey,
    region: input.defaultRegion,
  });
  if (!result.ok) {
    return { validated: false };
  }
  const encryptedSecret = encrypt(input.secretAccessKey);
  const insertValues = {
    organizationId: input.organizationId,
    accessKeyId: input.accessKeyId,
    secretAccessKeyEncrypted: encryptedSecret,
    defaultRegion: input.defaultRegion,
    awsAccountId: result.accountId ?? null,
    validatedAt: new Date(),
    updatedAt: new Date(),
  };
  const updatePayload = {
    accessKeyId: input.accessKeyId,
    secretAccessKeyEncrypted: encryptedSecret,
    defaultRegion: input.defaultRegion,
    awsAccountId: result.accountId ?? null,
    validatedAt: new Date(),
    updatedAt: new Date(),
  };
  await db
    .insert(orgAwsCredentials)
    .values(insertValues)
    .onConflictDoUpdate({ target: orgAwsCredentials.organizationId, set: updatePayload });
  return { validated: true, accountId: result.accountId, defaultRegion: input.defaultRegion };
}

export async function getCredentialsStatus(organizationId: string): Promise<CredentialsStatus> {
  const [row] = await db
    .select({
      validatedAt: orgAwsCredentials.validatedAt,
      awsAccountId: orgAwsCredentials.awsAccountId,
      defaultRegion: orgAwsCredentials.defaultRegion,
    })
    .from(orgAwsCredentials)
    .where(eq(orgAwsCredentials.organizationId, organizationId));
  if (!row) return { exists: false, validated: false };
  return {
    exists: true,
    validated: row.validatedAt != null,
    accountId: row.awsAccountId ?? undefined,
    defaultRegion: row.defaultRegion,
  };
}

export async function hasValidCredentials(organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ validatedAt: orgAwsCredentials.validatedAt })
    .from(orgAwsCredentials)
    .where(eq(orgAwsCredentials.organizationId, organizationId));
  return !!row && row.validatedAt != null;
}

export async function deleteCredentials(organizationId: string): Promise<void> {
  await db.delete(orgAwsCredentials).where(eq(orgAwsCredentials.organizationId, organizationId));
}
