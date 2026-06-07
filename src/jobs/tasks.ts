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
      await db
        .update(project)
        .set({ status: "failed", failureReason: e instanceof Error ? e.message : "provision failed", updatedAt: new Date() })
        .where(eq(project.ref, ref));
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
      await getProvisionerFor(row).resume(row);
      await db.update(project).set({ status: "active", updatedAt: new Date() }).where(eq(project.ref, ref));
    } catch (e) {
      await db
        .update(project)
        .set({ status: "failed", failureReason: e instanceof Error ? e.message : "resume failed", updatedAt: new Date() })
        .where(eq(project.ref, ref));
    }
  },
  delete: async (payload: unknown): Promise<void> => {
    const { ref } = payload as { ref: string };
    const row = await loadByRef(ref);
    if (!row) return;
    try {
      await getProvisionerFor(row).delete(row);
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
    const rows = await db
      .select()
      .from(project)
      .where(and(eq(project.status, "active"), eq(project.infrastructureType, "shared")));
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
