import type { WorkerUtils } from "graphile-worker";
import { getEnv } from "../config/env";
import { taskList } from "./tasks";

export interface Queue {
  enqueue(task: string, payload: unknown): Promise<void>;
}

// Runs the matching task handler synchronously — used in tests/dev.
export class InlineQueue implements Queue {
  async enqueue(task: string, payload: unknown): Promise<void> {
    const handler = (taskList as Record<string, (p: unknown) => Promise<void>>)[task];
    if (!handler) throw new Error(`Unknown task: ${task}`);
    await handler(payload);
  }
}

// Durable Postgres-backed queue (graphile-worker).
export class GraphileQueue implements Queue {
  private utils?: WorkerUtils;
  constructor(private readonly connectionString: string) {}
  async enqueue(task: string, payload: unknown): Promise<void> {
    if (!this.utils) {
      const { makeWorkerUtils } = await import("graphile-worker");
      this.utils = await makeWorkerUtils({ connectionString: this.connectionString });
      await this.utils.migrate();
    }
    // [console fork] Serialize ALL jobs for a given project. The worker runs with
    // concurrency > 1, so without this two lifecycle jobs for the same project (e.g.
    // pause + delete, resume + reconfigure, restore_physical + reconfigure) could run at
    // once — and the tasks' status guards are read-then-act, not atomic. graphile-worker
    // runs jobs in the same named queue strictly serially, so a per-project queue makes
    // every infra op (provision / pause / resume / restart / reconfigure / resize /
    // restore / delete / branch / deploy) wait its turn on the instance. The ref is a
    // bounded per-project value (the intended use of queueName), not a per-job random key.
    const ref = (payload as { ref?: unknown } | null)?.ref;
    const spec = typeof ref === "string" && ref ? { queueName: `project:${ref}` } : undefined;
    await this.utils.addJob(task, payload, spec);
  }
}

let current: Queue | undefined;

export function getQueue(): Queue {
  if (!current) current = new GraphileQueue(getEnv().DATABASE_URL);
  return current;
}
export function setQueue(q: Queue): void {
  current = q;
}
export function resetQueue(): void {
  current = undefined;
}
