import { Hono } from "hono";
import { auth } from "./auth";
import { onError } from "./http/error";
import { installGate } from "./http/install-gate";
import { health } from "./http/health";
import { me } from "./http/me";

export const app = new Hono();

app.onError(onError);

// Health and better-auth (incl. /api/auth/install/*) are not gated.
app.route("/", health);
app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// Everything under /api/v1 is gated until install completes.
app.use("/api/v1/*", installGate);
app.route("/", me);
