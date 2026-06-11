// [console fork] EC2 remote-exec via SSM. AL2023 ships the SSM agent, so once an
// instance has an IAM role granting AmazonSSMManagedInstanceCore we can run shell
// commands on it (RAM/disk metrics, supavisor logs, secrets/realtime writes) without
// SSH or an inbound port.
//
// IAM resources are PER-INSTANCE (named by ref) so they can be torn down cleanly:
// deleteInstanceRole() runs on project delete AND on provision rollback. Nothing
// accumulates.
import {
  IAMClient,
  CreateRoleCommand,
  AttachRolePolicyCommand,
  CreateInstanceProfileCommand,
  AddRoleToInstanceProfileCommand,
  RemoveRoleFromInstanceProfileCommand,
  DeleteInstanceProfileCommand,
  DetachRolePolicyCommand,
  DeleteRoleCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
} from "@aws-sdk/client-iam";
import {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand,
} from "@aws-sdk/client-ssm";

const SSM_POLICY_ARN = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore";

// [console fork] Inline policy letting the instance's storage service drive AWS S3 Tables —
// the backend for Iceberg analytics buckets (storage proxies the S3 Tables REST catalog with
// sigv4 signed by this role). Scoped to S3 Tables only; regular S3 is untouched.
const S3_TABLES_POLICY_NAME = "supabase-iceberg-s3tables";
const S3_TABLES_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Action: ["s3tables:*"], Resource: "*" }],
});

export function roleNameFor(ref: string): string {
  return `supabase-console-ssm-${ref}`;
}

const EC2_TRUST = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }],
});

function isAlready(e: unknown): boolean {
  return (e as { name?: string })?.name === "EntityAlreadyExists";
}
function isMissing(e: unknown): boolean {
  return (e as { name?: string })?.name === "NoSuchEntity";
}

/** Create the per-instance role + instance profile (idempotent). Returns the profile name. */
export async function ensureInstanceRole(iam: IAMClient, ref: string): Promise<string> {
  const name = roleNameFor(ref);
  try {
    await iam.send(new CreateRoleCommand({ RoleName: name, AssumeRolePolicyDocument: EC2_TRUST }));
  } catch (e) {
    if (!isAlready(e)) throw e;
  }
  try {
    await iam.send(new AttachRolePolicyCommand({ RoleName: name, PolicyArn: SSM_POLICY_ARN }));
  } catch (e) {
    if (!isAlready(e)) throw e;
  }
  try {
    await iam.send(new CreateInstanceProfileCommand({ InstanceProfileName: name }));
  } catch (e) {
    if (!isAlready(e)) throw e;
  }
  try {
    await iam.send(new AddRoleToInstanceProfileCommand({ InstanceProfileName: name, RoleName: name }));
  } catch (e) {
    if (!isAlready(e)) throw e;
  }
  // Inline S3 Tables policy (Iceberg analytics buckets). PutRolePolicy is an upsert.
  await iam.send(
    new PutRolePolicyCommand({ RoleName: name, PolicyName: S3_TABLES_POLICY_NAME, PolicyDocument: S3_TABLES_POLICY })
  );
  return name;
}

/** Full teardown of the per-instance role + profile. Best-effort + idempotent. */
export async function deleteInstanceRole(iam: IAMClient, ref: string): Promise<void> {
  const name = roleNameFor(ref);
  const steps = [
    () => iam.send(new RemoveRoleFromInstanceProfileCommand({ InstanceProfileName: name, RoleName: name })),
    () => iam.send(new DeleteInstanceProfileCommand({ InstanceProfileName: name })),
    () => iam.send(new DetachRolePolicyCommand({ RoleName: name, PolicyArn: SSM_POLICY_ARN })),
    () => iam.send(new DeleteRolePolicyCommand({ RoleName: name, PolicyName: S3_TABLES_POLICY_NAME })),
    () => iam.send(new DeleteRoleCommand({ RoleName: name })),
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (e) {
      if (!isMissing(e)) throw e; // tolerate already-gone, surface real failures
    }
  }
}

/** Run a shell command on the instance via SSM. Returns stdout (throws on failure). */
export async function runCommand(ssm: SSMClient, instanceId: string, command: string): Promise<string> {
  const sent = await ssm.send(
    new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: "AWS-RunShellScript",
      Parameters: { commands: [command] },
    })
  );
  const commandId = sent.Command?.CommandId;
  if (!commandId) throw new Error("SSM SendCommand returned no command id");
  // Poll for completion (up to ~60s). Most commands (psql, file writes) finish in well
  // under a second, so poll quickly first and back off, to keep interactive ops snappy.
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, i < 10 ? 400 : 1000));
    try {
      const inv = await ssm.send(
        new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId })
      );
      const status = inv.Status;
      if (status === "Success") return inv.StandardOutputContent ?? "";
      if (status === "Failed" || status === "Cancelled" || status === "TimedOut") {
        throw new Error(`SSM command ${status}: ${inv.StandardErrorContent?.slice(0, 200) ?? ""}`);
      }
    } catch (e) {
      // InvocationDoesNotExist right after SendCommand — keep polling.
      if ((e as { name?: string })?.name !== "InvocationDoesNotExist") throw e;
    }
  }
  throw new Error("SSM command did not complete in time");
}
