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
});

serve({ fetch: app.fetch, port: getEnv().PORT }, (info) => {
  console.log(`supabase-console listening on http://localhost:${info.port}`);
});

startWorker().catch((err) => {
  console.error("worker failed to start", err);
  process.exit(1);
});
