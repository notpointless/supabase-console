import { run, type Runner } from "graphile-worker";
import { getEnv } from "../config/env";
import { taskList } from "./tasks";

export async function startWorker(): Promise<Runner> {
  return run({
    connectionString: getEnv().DATABASE_URL,
    concurrency: 5,
    noHandleSignals: true,
    pollInterval: 500,
    // Our handlers accept (payload) only; the second `helpers` arg is unused
    // but compatible — TypeScript allows functions with fewer params here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    taskList: taskList as any,
  });
}
