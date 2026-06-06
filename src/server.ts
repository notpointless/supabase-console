import { serve } from "@hono/node-server";
import { app } from "./app";
import { getEnv } from "./config/env";
import { startWorker } from "./jobs/worker";

serve({ fetch: app.fetch, port: getEnv().PORT }, (info) => {
  console.log(`supabase-console listening on http://localhost:${info.port}`);
});

startWorker().catch((err) => {
  console.error("worker failed to start", err);
  process.exit(1);
});
