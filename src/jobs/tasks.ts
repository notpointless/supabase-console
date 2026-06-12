import { eq, and, lt, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { project } from "../db/schema";
import { getProvisionerFor } from "../projects/provisioner";

async function loadByRef(ref: string) {
  const [row] = await db.select().from(project).where(eq(project.ref, ref));
  return row;
}

// [console fork] HANG PROTECTION.
//
// Jobs run on a per-project serialized queue (queue.ts). graphile-worker locks both the JOB and
// the QUEUE while a worker processes it. If that worker dies UNGRACEFULLY (crash / kill / a
// `docker` op that hangs), those locks are left set and graphile won't reissue them — nor any
// LATER job in the same per-project queue — until a multi-hour TTL. The visible symptom: a
// project stuck "coming up", or a delete/reconfigure that never runs.
//
// releaseStaleLocks() clears locks older than `minutes` (orphaned by a dead worker). Called on
// startup (worker.ts) with a short window — on a fresh start nothing is legitimately running, so
// any existing lock is from the previous, now-dead pool — and periodically by the reaper with a
// generous window so an actively-running long job (e.g. a physical restore) is never disturbed.
export async function releaseStaleLocks(minutes: number): Promise<void> {
  await db.execute(
    sql`update graphile_worker._private_job_queues set locked_at = null, locked_by = null
        where locked_at is not null and locked_at < now() - make_interval(mins => ${minutes})`
  );
  await db.execute(
    sql`update graphile_worker._private_jobs set locked_at = null, locked_by = null
        where locked_at is not null and locked_at < now() - make_interval(mins => ${minutes})`
  );
}

export const taskList = {
  provision: async (payload: unknown): Promise<void> => {
    const { ref } = payload as { ref: string };
    const row = await loadByRef(ref);
    if (!row) return;
    if (row.status !== "provisioning") return;
    try {
      const result = await getProvisionerFor(row).provision(row);
      await db
        .update(project)
        .set({ status: "active", connection: result.connection, failureReason: null, updatedAt: new Date() })
        .where(and(eq(project.ref, ref), eq(project.status, "provisioning")));
    } catch (e) {
      // [console fork] A failed provision must NOT leave a project behind. Roll back
      // fully: best-effort tear down any AWS/stack resources, then delete the row.
      // (The reason is logged here since the record is gone.)
      const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      // eslint-disable-next-line no-console
      console.error(`[provision] ${ref} failed — rolling back:`, reason);
      try {
        const current = await loadByRef(ref);
        if (current) await getProvisionerFor(current).delete(current);
      } catch {
        // no instance recorded yet / nothing to tear down
      }
      await db.delete(project).where(eq(project.ref, ref));
    }
  },
  pause: async (payload: unknown): Promise<void> => {
    const { ref } = payload as { ref: string };
    const row = await loadByRef(ref);
    if (!row) return;
    if (row.status !== "active") return;
    try {
      await getProvisionerFor(row).pause(row);
      await db.update(project).set({ status: "paused", updatedAt: new Date() }).where(eq(project.ref, ref));
    } catch (e) {
      await db
        .update(project)
        .set({ status: "failed", failureReason: e instanceof Error ? e.message : "pause failed", updatedAt: new Date() })
        .where(eq(project.ref, ref));
    }
  },
  resume: async (payload: unknown): Promise<void> => {
    const { ref } = payload as { ref: string };
    const row = await loadByRef(ref);
    if (!row) return;
    if (row.status !== "paused") return;
    try {
      const conn = await getProvisionerFor(row).resume(row);
      // [console fork] EC2 instances get a NEW public host on start; persist it so the project
      // (and its internal-config endpoint) point at the live instance after pause/resume.
      await db
        .update(project)
        .set({ status: "active", ...(conn ? { connection: conn } : {}), updatedAt: new Date() })
        .where(eq(project.ref, ref));
    } catch (e) {
      await db
        .update(project)
        .set({ status: "failed", failureReason: e instanceof Error ? e.message : "resume failed", updatedAt: new Date() })
        .where(eq(project.ref, ref));
    }
  },
  restart: async (payload: unknown): Promise<void> => {
    // Restart is non-destructive — don't flip status to "failed" on error (the
    // services are still whatever they were); just attempt + surface via the queue.
    const { ref, services } = payload as { ref: string; services?: string[] };
    const row = await loadByRef(ref);
    if (!row) return;
    await getProvisionerFor(row).restart?.(row, services);
    await db.update(project).set({ updatedAt: new Date() }).where(eq(project.ref, ref));
  },
  // [console fork] Apply a project's current stored config (auth-config / third-party-auth /
  // data API) to its running stack. Config endpoints enqueue this instead of reconfiguring
  // inline, so the HTTP request returns immediately rather than blocking 10-30s on a container
  // recreate (which timed the dashboard out). Works for shared + EC2 — both implement reconfigure.
  reconfigure: async (payload: unknown): Promise<void> => {
    const { ref } = payload as { ref: string };
    const row = await loadByRef(ref);
    if (!row) return;
    if (row.status !== "active") return;
    await getProvisionerFor(row).reconfigure?.(row);
    await db.update(project).set({ updatedAt: new Date() }).where(eq(project.ref, ref));
  },
  resize_compute: async (payload: unknown): Promise<void> => {
    // Resize the dedicated instance to the project's current computeSize. The route flips the
    // project to "resuming" first; we put it back to "active" on success (persisting the fresh
    // connection — the public host can change on stop/start) or "failed" on error, so a resize
    // that dies mid-way doesn't leave the project showing ACTIVE_HEALTHY while the instance is
    // stopped. Guard on "resuming" so a duplicate job no-ops instead of re-stopping a live box.
    const { ref } = payload as { ref: string };
    const row = await loadByRef(ref);
    if (!row) return;
    if (row.status !== "resuming") return;
    try {
      const conn = await getProvisionerFor(row).resize?.(row);
      await db
        .update(project)
        .set({ status: "active", ...(conn ? { connection: conn } : {}), failureReason: null, updatedAt: new Date() })
        .where(eq(project.ref, ref));
    } catch (e) {
      await db
        .update(project)
        .set({ status: "failed", failureReason: e instanceof Error ? e.message : "compute resize failed", updatedAt: new Date() })
        .where(eq(project.ref, ref));
    }
  },
  // [console fork] Enable Caddy/TLS for a custom hostname over SSM (docker compose up — pulls
  // the caddy image on first use). Async so the request doesn't block past the dashboard timeout;
  // the Custom Domains page polls and flips to active when this finishes.
  activate_custom_hostname: async (payload: unknown): Promise<void> => {
    const { ref } = payload as { ref: string };
    const row = await loadByRef(ref);
    if (!row) return;
    const { activateCustomHostname } = await import("../projects/custom-hostname.js");
    await activateCustomHostname(row);
  },
  // [console fork] Apply an EC2 disk (EBS) resize: online ModifyVolume + wait + SSM filesystem
  // grow. Async (this task) so the HTTP request returns immediately instead of blocking minutes.
  resize_disk: async (payload: unknown): Promise<void> => {
    const { ref, cfg } = payload as {
      ref: string;
      cfg: { sizeGb: number; iops: number; throughput: number; type: string };
    };
    const row = await loadByRef(ref);
    if (!row) return;
    await getProvisionerFor(row).resizeDisk?.(row, cfg);
  },
  delete: async (payload: unknown): Promise<void> => {
    const { ref } = payload as { ref: string };
    const row = await loadByRef(ref);
    if (!row) return;
    try {
      await getProvisionerFor(row).delete(row);
      // [console fork] Tear down the PrivateLink endpoint service + NLB if one was provisioned.
      const { teardownPrivatelink } = await import("../integrations/privatelink-service.js");
      await teardownPrivatelink(row).catch(() => {});
      await db.delete(project).where(eq(project.ref, ref));
    } catch (e) {
      await db
        .update(project)
        .set({ status: "failed", failureReason: e instanceof Error ? e.message : "delete failed", updatedAt: new Date() })
        .where(eq(project.ref, ref));
    }
  },
  // [console fork] Provision a preview branch: bring up its isolated stack, then
  // seed its database (schema, +data if requested) from the parent project.
  provision_branch: async (payload: unknown): Promise<void> => {
    const { ref, withData } = payload as { ref: string; withData?: boolean };
    const row = await loadByRef(ref);
    if (!row) return;
    if (row.status !== "provisioning") return;
    const { seedBranchFromParent } = await import("../projects/branches.js");
    try {
      const result = await getProvisionerFor(row).provision(row);
      // Stack is up; record connection before seeding so the branch is reachable.
      await db
        .update(project)
        .set({ connection: result.connection, updatedAt: new Date() })
        .where(eq(project.ref, ref));
      await seedBranchFromParent({ ...row, connection: result.connection }, !!withData);
      await db
        .update(project)
        .set({ status: "active", failureReason: null, updatedAt: new Date() })
        .where(and(eq(project.ref, ref), eq(project.status, "provisioning")));
    } catch (e) {
      await db
        .update(project)
        .set({ status: "failed", failureReason: e instanceof Error ? e.message : "branch provision failed", updatedAt: new Date() })
        .where(eq(project.ref, ref));
    }
  },
  // [console fork] Re-seed an existing branch's database from its parent (branch reset).
  seed_branch: async (payload: unknown): Promise<void> => {
    const { ref, withData } = payload as { ref: string; withData?: boolean };
    const row = await loadByRef(ref);
    if (!row) return;
    const { seedBranchFromParent } = await import("../projects/branches.js");
    await seedBranchFromParent(row, !!withData);
  },
  // [console fork] Apply a project's connected GitHub repo migrations (push webhook).
  github_deploy: async (payload: unknown): Promise<void> => {
    const { ref } = payload as { ref: string };
    const { deployProject } = await import("../integrations/github-deploy.js");
    try {
      await deployProject(ref);
    } catch {
      // best-effort; surfaced via manual deploy if it fails here
    }
  },
  // [console fork] Restore an EC2 project's root volume from an EBS snapshot (physical backup).
  // The route flips status to "resuming" (RESTORING in the dashboard) before enqueueing; we put
  // it back to active on success. The volume swap stops/starts the instance, so reconfigure
  // afterwards to refresh the stack env on the restored volume (which may carry stale config).
  restore_physical: async (payload: unknown): Promise<void> => {
    const { ref, id } = payload as { ref: string; id: number };
    const row = await loadByRef(ref);
    if (!row) return;
    if (row.status !== "resuming") return;
    const { restorePhysicalBackup } = await import("../projects/physical-backups.js");
    try {
      await restorePhysicalBackup(row, id);
      try {
        await getProvisionerFor(row).reconfigure?.(row);
      } catch {
        // instance is up on the restored volume regardless; a later reconfigure fixes env drift
      }
      await db
        .update(project)
        .set({ status: "active", failureReason: null, updatedAt: new Date() })
        .where(eq(project.ref, ref));
    } catch (e) {
      await db
        .update(project)
        .set({ status: "failed", failureReason: e instanceof Error ? e.message : "physical restore failed", updatedAt: new Date() })
        .where(eq(project.ref, ref));
    }
  },
  // [console fork] Daily logical backup of every active shared-infra project
  // (scheduled via the worker crontab). Best-effort per project.
  backup_all: async (): Promise<void> => {
    const { createBackup } = await import("../projects/backups.js");
    const { listPhysicalBackups, createPhysicalBackup, prunePhysicalBackups } = await import(
      "../projects/physical-backups.js"
    );
    // [console fork] All active projects — shared (local container) AND dedicated/EC2 (dumped
    // over TCP from the instance). createBackup picks the right path per infra.
    const rows = await db.select().from(project).where(eq(project.status, "active"));
    for (const row of rows) {
      try {
        await createBackup(row);
      } catch {
        // best-effort; a failed backup for one project shouldn't stop the rest
      }
      // EC2 projects that opted into physical backups (>=1 snapshot) get a daily snapshot too,
      // pruned to the retention window.
      if (row.infrastructureType !== "shared") {
        try {
          const existing = await listPhysicalBackups(row);
          if (existing.length > 0) {
            await createPhysicalBackup(row);
            await prunePhysicalBackups(row);
          }
        } catch {
          // best-effort
        }
      }
    }
  },

  // [console fork] HANG PROTECTION reaper — runs on a schedule (worker.ts crontab). See
  // releaseStaleLocks() above for the failure mode it guards against. Two layers:
  reap_stuck_projects: async (): Promise<void> => {
    // 1) Free locks orphaned by a worker that died ungracefully, so a per-project queue blocked
    //    behind a dead lock (e.g. a delete that can never run) drains. 20 min is far beyond any
    //    normal op; only a large physical restore runs longer, and that legitimately holds its
    //    OWN project's queue — which we must not interrupt, hence the generous window.
    await releaseStaleLocks(20);

    const cutoff = new Date(Date.now() - 20 * 60 * 1000);

    // 2a) A project stuck "provisioning" never came up — destroy the half-built stack and drop the
    //     row (same contract as a failed provision: never leave a project behind). updatedAt is the
    //     create time until provision finishes, so this only fires once it's genuinely wedged.
    const wedgedProvisioning = await db
      .select()
      .from(project)
      .where(and(eq(project.status, "provisioning"), lt(project.updatedAt, cutoff)));
    for (const row of wedgedProvisioning) {
      console.error(`[reaper] destroying stuck-provisioning project ${row.ref} (no progress >20m)`);
      try {
        await getProvisionerFor(row).delete(row);
      } catch (err) {
        console.error(`[reaper] teardown failed for ${row.ref}`, err);
      }
      await db.delete(project).where(eq(project.id, row.id));
    }

    // 2b) A project wedged mid resume/restore HAS data — never destroy it. Flag it failed so the UI
    //     stops spinning and the user can retry the operation.
    const wedgedOps = await db
      .select()
      .from(project)
      .where(and(inArray(project.status, ["resuming", "restoring"]), lt(project.updatedAt, cutoff)));
    for (const row of wedgedOps) {
      console.error(`[reaper] flagging stuck ${row.status} project ${row.ref} as failed (retryable)`);
      await db
        .update(project)
        .set({
          status: "failed",
          failureReason: `${row.status} timed out — automatically recovered (hang protection)`,
          updatedAt: new Date(),
        })
        .where(eq(project.id, row.id));
    }
  },
};

export type TaskName = keyof typeof taskList;
