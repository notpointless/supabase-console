import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { project } from "../db/schema";
import { getProvisioner } from "../projects/provisioner";

async function loadByRef(ref: string) {
  const [row] = await db.select().from(project).where(eq(project.ref, ref));
  return row;
}

export const taskList = {
  provision: async (payload: unknown): Promise<void> => {
    const { ref } = payload as { ref: string };
    const row = await loadByRef(ref);
    if (!row) return;
    try {
      const result = await getProvisioner().provision(row);
      await db
        .update(project)
        .set({ status: "active", connection: result.connection, failureReason: null, updatedAt: new Date() })
        .where(eq(project.ref, ref));
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
    await getProvisioner().pause(row);
    await db.update(project).set({ status: "paused", updatedAt: new Date() }).where(eq(project.ref, ref));
  },
  resume: async (payload: unknown): Promise<void> => {
    const { ref } = payload as { ref: string };
    const row = await loadByRef(ref);
    if (!row) return;
    await getProvisioner().resume(row);
    await db.update(project).set({ status: "active", updatedAt: new Date() }).where(eq(project.ref, ref));
  },
  delete: async (payload: unknown): Promise<void> => {
    const { ref } = payload as { ref: string };
    const row = await loadByRef(ref);
    if (!row) return;
    await getProvisioner().delete(row);
    await db.delete(project).where(eq(project.ref, ref));
  },
};

export type TaskName = keyof typeof taskList;
