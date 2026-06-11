import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeSnapshotsCommand,
  CreateSnapshotCommand,
  DeleteSnapshotCommand,
  CreateVolumeCommand,
  DeleteVolumeCommand,
  AttachVolumeCommand,
  DetachVolumeCommand,
  StopInstancesCommand,
  StartInstancesCommand,
  ModifyInstanceAttributeCommand,
  waitUntilInstanceStopped,
  waitUntilInstanceRunning,
  waitUntilVolumeAvailable,
  waitUntilVolumeInUse,
} from "@aws-sdk/client-ec2";
import { SSMClient } from "@aws-sdk/client-ssm";
import type { Project } from "../db/schema";
import { getCredentials } from "../aws/credentials-service";
import { runCommand } from "./ec2-ssm";
import { AppError } from "../http/error";
import type { BackupInfo } from "./backups";

// [console fork] Physical backups for dedicated (EC2) projects: EBS snapshots of the instance's
// root volume (which holds /opt/supabase, including the Postgres data dir). Snapshots are
// crash-consistent; we CHECKPOINT Postgres + sync first (best-effort, over SSM) to minimise WAL
// replay on restore. Restore swaps the root volume for one created from the snapshot:
// stop (if running) -> create volume from snapshot in the instance's AZ -> detach old root ->
// attach new -> start -> reconfigure (re-resolves the public URL; the Elastic IP is stable).
// Lifecycle-safe: snapshot and restore both work whether the instance is running or stopped
// (paused project); a paused project comes back ACTIVE after restore, matching the dashboard's
// expectation that a restored project is running. Shared projects get a clear 400 — their
// recovery path is the logical pg_dump backups.

const REF_TAG = "supabase:project-ref";
const ID_TAG = "supabase:backup-id";
const MANAGED_TAG = "supabase:managed-by";
// Keep this many most-recent snapshots per project; the daily job prunes older ones.
export const SNAPSHOT_RETENTION = 7;

function assertEc2(p: Project): void {
  if (p.infrastructureType === "shared") {
    throw new AppError(
      400,
      "physical_backups_unavailable",
      "Physical backups are only available for dedicated (AWS EC2) projects. Shared projects use logical backups."
    );
  }
}

function instanceIdOf(p: Project): string {
  const id = (p.connection as { instanceId?: string } | null)?.instanceId;
  if (!id) throw new AppError(400, "no_instance", `Project ${p.ref} has no EC2 instance recorded`);
  return id;
}

async function ec2ClientFor(p: Project): Promise<EC2Client> {
  const creds = await getCredentials(p.organizationId);
  return new EC2Client({
    region: p.region ?? "us-east-1",
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
  });
}

async function ssmClientFor(p: Project): Promise<SSMClient> {
  const creds = await getCredentials(p.organizationId);
  return new SSMClient({
    region: p.region ?? "us-east-1",
    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey },
  });
}

interface RootInfo {
  state: string;
  az: string;
  rootDeviceName: string;
  rootVolumeId: string;
}

async function describeRoot(ec2: EC2Client, instanceId: string): Promise<RootInfo> {
  const out = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  const inst = out.Reservations?.[0]?.Instances?.[0];
  if (!inst) throw new AppError(404, "instance_not_found", "EC2 instance not found");
  const rootDeviceName = inst.RootDeviceName ?? "/dev/xvda";
  const mapping = (inst.BlockDeviceMappings ?? []).find((m) => m.DeviceName === rootDeviceName);
  const rootVolumeId = mapping?.Ebs?.VolumeId;
  if (!rootVolumeId) throw new AppError(500, "no_root_volume", "Instance has no root EBS volume");
  return {
    state: inst.State?.Name ?? "unknown",
    az: inst.Placement?.AvailabilityZone ?? "",
    rootDeviceName,
    rootVolumeId,
  };
}

function snapshotToBackup(s: {
  Tags?: { Key?: string; Value?: string }[];
  StartTime?: Date;
  State?: string;
}): BackupInfo {
  const idTag = s.Tags?.find((t) => t.Key === ID_TAG)?.Value;
  const ms = idTag ? Number(idTag) : s.StartTime ? s.StartTime.getTime() : 0;
  const status = s.State === "completed" ? "COMPLETED" : s.State === "error" ? "FAILED" : "PENDING";
  return {
    id: Math.floor(ms),
    inserted_at: new Date(ms).toISOString(),
    isPhysicalBackup: true,
    project_id: 0,
    status,
  };
}

async function describeProjectSnapshots(ec2: EC2Client, ref: string) {
  const out = await ec2.send(
    new DescribeSnapshotsCommand({
      OwnerIds: ["self"],
      Filters: [
        { Name: `tag:${REF_TAG}`, Values: [ref] },
        { Name: `tag:${MANAGED_TAG}`, Values: ["supabase-console"] },
      ],
    })
  );
  return out.Snapshots ?? [];
}

/** All EBS snapshots for the project, newest first (empty for shared projects). */
export async function listPhysicalBackups(p: Project): Promise<BackupInfo[]> {
  if (p.infrastructureType === "shared") return [];
  let ec2: EC2Client;
  try {
    ec2 = await ec2ClientFor(p);
  } catch {
    return []; // no AWS credentials configured — nothing to list
  }
  try {
    const snaps = await describeProjectSnapshots(ec2, p.ref);
    return snaps.map(snapshotToBackup).sort((a, b) => b.id - a.id);
  } catch {
    return [];
  }
}

/** Earliest/latest snapshot times (unix seconds) in the shape the dashboard's PITR pages read. */
export function physicalBackupData(backups: BackupInfo[]): Record<string, number> {
  const completed = backups.filter((b) => b.status === "COMPLETED");
  if (completed.length === 0) return {};
  const times = completed.map((b) => Math.floor(b.id / 1000));
  return {
    earliestPhysicalBackupDateUnix: Math.min(...times),
    latestPhysicalBackupDateUnix: Math.max(...times),
  };
}

/**
 * Snapshot the instance's root volume. Works while running (CHECKPOINT + sync first for a
 * cleaner image) or stopped (volume is still attached; the snapshot is simply cold-consistent).
 */
export async function createPhysicalBackup(p: Project): Promise<BackupInfo> {
  assertEc2(p);
  const ec2 = await ec2ClientFor(p);
  const instanceId = instanceIdOf(p);
  const root = await describeRoot(ec2, instanceId);

  if (root.state === "running") {
    // Best-effort: flush Postgres + the page cache so the crash-consistent snapshot needs
    // minimal WAL replay. A failure here never blocks the snapshot.
    try {
      const ssm = await ssmClientFor(p);
      await runCommand(
        ssm,
        instanceId,
        `docker exec supabase-db psql -U postgres -c CHECKPOINT || true\nsync`
      );
    } catch {
      /* snapshot proceeds crash-consistent */
    }
  }

  const ts = Date.now();
  const out = await ec2.send(
    new CreateSnapshotCommand({
      VolumeId: root.rootVolumeId,
      Description: `supabase-console physical backup of ${p.ref}`,
      TagSpecifications: [
        {
          ResourceType: "snapshot",
          Tags: [
            { Key: "Name", Value: `supabase-${p.ref}-${ts}` },
            { Key: REF_TAG, Value: p.ref },
            { Key: ID_TAG, Value: String(ts) },
            { Key: MANAGED_TAG, Value: "supabase-console" },
          ],
        },
      ],
    })
  );
  if (!out.SnapshotId) throw new AppError(500, "snapshot_failed", "EBS snapshot was not created");
  // The snapshot completes in the background; it lists as PENDING until done.
  return { id: ts, inserted_at: new Date(ts).toISOString(), isPhysicalBackup: true, project_id: 0, status: "PENDING" };
}

/** Delete ALL of a project's snapshots — called when the project itself is deleted. */
export async function deleteAllPhysicalBackups(p: Project): Promise<void> {
  if (p.infrastructureType === "shared") return;
  const ec2 = await ec2ClientFor(p);
  const snaps = await describeProjectSnapshots(ec2, p.ref);
  for (const s of snaps) {
    if (!s.SnapshotId) continue;
    try {
      await ec2.send(new DeleteSnapshotCommand({ SnapshotId: s.SnapshotId }));
    } catch {
      /* best-effort */
    }
  }
}

/** Delete snapshots beyond the retention window (newest SNAPSHOT_RETENTION are kept). */
export async function prunePhysicalBackups(p: Project): Promise<void> {
  if (p.infrastructureType === "shared") return;
  const ec2 = await ec2ClientFor(p);
  const snaps = await describeProjectSnapshots(ec2, p.ref);
  const sorted = snaps
    .filter((s) => s.SnapshotId)
    .sort((a, b) => (b.StartTime?.getTime() ?? 0) - (a.StartTime?.getTime() ?? 0));
  for (const s of sorted.slice(SNAPSHOT_RETENTION)) {
    try {
      await ec2.send(new DeleteSnapshotCommand({ SnapshotId: s.SnapshotId! }));
    } catch {
      /* best-effort; in-use/permission errors shouldn't stop the rest */
    }
  }
}

/**
 * Restore the instance's root volume from a snapshot (identified by our backup id). The swap:
 * stop if running -> new volume from snapshot (same AZ/type) -> detach old root -> attach new ->
 * start -> caller reconfigures. On a failed swap the old volume is re-attached (best effort) so
 * the instance is never left without a root volume. The old volume is deleted only after the
 * instance is running on the new one.
 */
export async function restorePhysicalBackup(p: Project, backupId: number): Promise<void> {
  assertEc2(p);
  const ec2 = await ec2ClientFor(p);
  const instanceId = instanceIdOf(p);

  const snaps = await describeProjectSnapshots(ec2, p.ref);
  const snap = snaps.find((s) => s.Tags?.some((t) => t.Key === ID_TAG && t.Value === String(backupId)));
  if (!snap?.SnapshotId) throw new AppError(404, "backup_not_found", "Physical backup not found");
  if (snap.State !== "completed") {
    throw new AppError(400, "backup_not_ready", "This backup is still being created — try again shortly");
  }

  const root = await describeRoot(ec2, instanceId);
  const waiterCfg = { client: ec2, maxWaitTime: 600 };

  // 1. Stop the instance if it's running (a stopped/paused project skips straight to the swap).
  if (root.state !== "stopped") {
    await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
    await waitUntilInstanceStopped(waiterCfg, { InstanceIds: [instanceId] });
  }

  // 2. New volume from the snapshot, in the instance's AZ.
  const created = await ec2.send(
    new CreateVolumeCommand({
      SnapshotId: snap.SnapshotId,
      AvailabilityZone: root.az,
      VolumeType: "gp3",
      TagSpecifications: [
        {
          ResourceType: "volume",
          Tags: [
            { Key: "Name", Value: `supabase-${p.ref}` },
            { Key: REF_TAG, Value: p.ref },
            { Key: MANAGED_TAG, Value: "supabase-console" },
          ],
        },
      ],
    })
  );
  const newVolumeId = created.VolumeId;
  if (!newVolumeId) throw new AppError(500, "restore_failed", "Could not create a volume from the snapshot");
  await waitUntilVolumeAvailable(waiterCfg, { VolumeIds: [newVolumeId] });

  // 3. Swap root volumes. If attaching the new volume fails, re-attach the old one so the
  //    instance is never left rootless, then surface the error.
  await ec2.send(new DetachVolumeCommand({ VolumeId: root.rootVolumeId, InstanceId: instanceId }));
  await waitUntilVolumeAvailable(waiterCfg, { VolumeIds: [root.rootVolumeId] });
  try {
    await ec2.send(
      new AttachVolumeCommand({ VolumeId: newVolumeId, InstanceId: instanceId, Device: root.rootDeviceName })
    );
    await waitUntilVolumeInUse(waiterCfg, { VolumeIds: [newVolumeId] });
  } catch (err) {
    try {
      await ec2.send(
        new AttachVolumeCommand({ VolumeId: root.rootVolumeId, InstanceId: instanceId, Device: root.rootDeviceName })
      );
      await waitUntilVolumeInUse(waiterCfg, { VolumeIds: [root.rootVolumeId] });
      await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
      await ec2.send(new DeleteVolumeCommand({ VolumeId: newVolumeId })).catch(() => {});
    } catch {
      /* rollback is best-effort; the original error is what matters */
    }
    throw err;
  }

  // 4. AttachVolume does NOT inherit DeleteOnTermination — without this, deleting the project
  //    (instance termination) would orphan the restored root volume and keep billing for it.
  await ec2
    .send(
      new ModifyInstanceAttributeCommand({
        InstanceId: instanceId,
        BlockDeviceMappings: [
          { DeviceName: root.rootDeviceName, Ebs: { VolumeId: newVolumeId, DeleteOnTermination: true } },
        ],
      })
    )
    .catch(() => {});

  // 5. Bring the instance up on the restored volume (the Elastic IP stays associated, so the
  //    public host is unchanged; the caller's reconfigure refreshes the stack env regardless).
  await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
  await waitUntilInstanceRunning(waiterCfg, { InstanceIds: [instanceId] });

  // 6. Delete the detached old root volume (detaching cleared its DeleteOnTermination cleanup
  //    path, so an explicit delete is the only thing preventing an orphan).
  await ec2.send(new DeleteVolumeCommand({ VolumeId: root.rootVolumeId })).catch(() => {});
}
