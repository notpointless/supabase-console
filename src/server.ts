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
  console.error("[uncaughtException]", err);
  // A failure to BIND the port (EADDRINUSE when tsx-watch restarts before the old process
  // frees :3000, or EACCES) must be FATAL — swallowing it leaves a zombie that holds the
  // port but can't serve, so the real server never binds and the BFF gets ECONNREFUSED
  // ("API error communicating with the server"). Exit so the supervisor starts cleanly.
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EADDRINUSE" || code === "EACCES") {
    console.error(`[uncaughtException] fatal listen error ${code} — exiting for a clean restart`);
    process.exit(1);
  }
});

serve({ fetch: app.fetch, port: getEnv().PORT }, (info) => {
  console.log(`supabase-console listening on http://localhost:${info.port}`);
});

startWorker().catch((err) => {
  console.error("worker failed to start", err);
  process.exit(1);
});
