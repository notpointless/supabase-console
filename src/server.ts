// [console fork] touch to force full tsx-watch reload
import { serve } from "@hono/node-server";
import { app } from "./app";
import { getEnv } from "./config/env";
import { startWorker } from "./jobs/worker";

// [console fork] Keep the control plane alive through unexpected async errors. Without these,
// a single unhandled rejection or exception — often from a background job or a `docker` call
// after a provision — silently terminates Node and logs everyone out (the process just ends,
// no stack trace). Log loudly and stay up; a dropped background task must never take down auth.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  // Stay up through unexpected async errors (a dropped background job must never take down
  // auth). Port-bind errors are handled by the listen retry below, not here.
  console.error("[uncaughtException]", err);
});

// [console fork] Bind with a short retry on EADDRINUSE. tsx-watch reloads on every file edit by
// killing the old process and spawning a new one; the old process can still hold :3000 for a
// moment, so a naive bind fails with EADDRINUSE. Previously the server EXITED on that — but
// tsx-watch does NOT respawn a process that exits on its own, so a single reload race left the
// control plane (and therefore login) down until the next file change. Retrying the bind lets a
// reload self-heal; only a non-transient error (e.g. EACCES) is fatal.
const PORT = getEnv().PORT;
function listen(attempt = 0): void {
  const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`supabase-console listening on http://localhost:${info.port}`);
  });
  (server as unknown as { on?: (e: string, cb: (err: NodeJS.ErrnoException) => void) => void }).on?.(
    "error",
    (err) => {
      if (err.code === "EADDRINUSE" && attempt < 30) {
        if (attempt % 4 === 0) {
          console.warn(`[listen] :${PORT} busy (EADDRINUSE) — retrying (attempt ${attempt + 1})`);
        }
        setTimeout(() => listen(attempt + 1), 500);
      } else {
        console.error(`[listen] fatal ${err.code ?? err.message} — exiting`);
        process.exit(1);
      }
    }
  );
}
listen();

startWorker().catch((err) => {
  console.error("worker failed to start", err);
  process.exit(1);
});
