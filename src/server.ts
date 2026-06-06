import { serve } from "@hono/node-server";
import { app } from "./app";
import { getEnv } from "./config/env";

serve({ fetch: app.fetch, port: getEnv().PORT }, (info) => {
  console.log(`supabase-console listening on http://localhost:${info.port}`);
});
