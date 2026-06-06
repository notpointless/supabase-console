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
    await this.utils.addJob(task, payload);
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
