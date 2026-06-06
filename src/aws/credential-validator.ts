export interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export interface ValidationResult {
  ok: boolean;
  accountId?: string;
  error?: string;
}

export interface CredentialValidator {
  validate(creds: AwsCreds): Promise<ValidationResult>;
}

export class StsValidator implements CredentialValidator {
  async validate(creds: AwsCreds): Promise<ValidationResult> {
    const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
    const client = new STSClient({
      region: creds.region,
      credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
    });
    try {
      const res = await client.send(new GetCallerIdentityCommand({}));
      return { ok: true, accountId: res.Account };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "AWS validation failed" };
    }
  }
}

let current: CredentialValidator | undefined;

export function getValidator(): CredentialValidator {
  if (!current) current = new StsValidator();
  return current;
}
export function setValidator(v: CredentialValidator): void {
  current = v;
}
export function resetValidator(): void {
  current = undefined;
}
