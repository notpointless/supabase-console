import { run, type Runner } from "graphile-worker";
import { getEnv } from "../config/env";
import { taskList, releaseStaleLocks } from "./tasks";

export async function startWorker(): Promise<Runner> {
  // [console fork] HANG PROTECTION (startup). If the previous backend died ungracefully (crash,
  // kill, tsx-watch reload race), its worker left job + per-project QUEUE locks set — graphile
  // won't reissue those, or any later job in the same per-project queue, for hours. The classic
  // symptom is a project stuck "coming up" or a delete that never runs. On a fresh start nothing
  // is legitimately running yet, so any lock older than 1 min is from the dead pool — release it
  // so blocked queues drain immediately. (The reap_stuck_projects cron repeats this at runtime.)
  try {
    await releaseStaleLocks(1);
  } catch (err) {
    console.error("[startWorker] failed to release stale locks", err);
  }

  return run({
    connectionString: getEnv().DATABASE_URL,
    concurrency: 5,
    noHandleSignals: true,
    pollInterval: 500,
    // [console fork] Daily logical backups of all active shared projects (~00:10 local), plus a
    // hang-protection sweep every 5 min (frees dead-worker locks, recovers wedged projects).
    crontab: ["10 0 * * * backup_all ?max=1", "*/5 * * * * reap_stuck_projects ?max=1"].join("\n"),
    // Our handlers accept (payload) only; the second `helpers` arg is unused
    // but compatible — TypeScript allows functions with fewer params here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    taskList: taskList as any,
  });
}
