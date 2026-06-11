import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { project } from "../db/schema";
import { getProvisionerFor } from "../projects/provisioner";

async function loadByRef(ref: string) {
  const [row] = await db.select().from(project).where(eq(project.ref, ref));
  return row;
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
    // Resize the dedicated instance to the project's current computeSize. The public
    // host changes on stop/start, so persist the returned connection.
    const { ref } = payload as { ref: string };
    const row = await loadByRef(ref);
    if (!row) return;
    const conn = await getProvisionerFor(row).resize?.(row);
    if (conn) {
      await db.update(project).set({ connection: conn, updatedAt: new Date() }).where(eq(project.ref, ref));
    }
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
  // [console fork] Daily logical backup of every active shared-infra project
  // (scheduled via the worker crontab). Best-effort per project.
  backup_all: async (): Promise<void> => {
    const { createBackup } = await import("../projects/backups.js");
    // [console fork] All active projects — shared (local container) AND dedicated/EC2 (dumped
    // over TCP from the instance). createBackup picks the right path per infra.
    const rows = await db.select().from(project).where(eq(project.status, "active"));
    for (const row of rows) {
      try {
        await createBackup(row);
      } catch {
        // best-effort; a failed backup for one project shouldn't stop the rest
      }
    }
  },
};

export type TaskName = keyof typeof taskList;
