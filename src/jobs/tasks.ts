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
};

export type TaskName = keyof typeof taskList;
