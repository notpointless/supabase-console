import { Hono, type Context } from "hono";
import { auth } from "./auth";
import { onError } from "./http/error";
import { installGate } from "./http/install-gate";
import { health } from "./http/health";
import { me } from "./http/me";
import { accessTokens } from "./account/access-token-routes";
import { projects } from "./projects/routes";
import { orgSso } from "./auth/sso-routes";
import { orgOauthApps } from "./auth/oauth-app-routes";
import { orgSecurity } from "./org/security-routes";
import { integrations } from "./integrations/routes";
import { usage } from "./usage/routes";
import { auditMiddleware } from "./audit/middleware";
import { auditRoutes } from "./audit/routes";

export const app = new Hono();

app.onError(onError);

// Health and better-auth (incl. /api/auth/install/*) are not gated.
app.route("/", health);

// Force SSO provider management through our secret-stripping /api/v1 surface.
// The @better-auth/sso plugin's /sso/register echoes submitted secrets (cert /
// clientSecret / privateKey) in its response; /sso/delete-provider is blocked
// for symmetry.  The actual SSO sign-in flow — sign-in, SAML ACS/SLO, SP
// metadata — is NOT blocked and continues to reach auth.handler below.
// Exact plugin paths verified in node_modules/@better-auth/sso/dist/index.mjs:
//   createAuthEndpoint("/sso/register", ...)        → POST /api/auth/sso/register
//   createAuthEndpoint("/sso/delete-provider", ...) → POST /api/auth/sso/delete-provider
const ssoBlocked = (c: Context) =>
  c.json(
    { error: { code: "use_v1_sso", message: "Use /api/v1/organizations/:orgId/sso" } },
    405,
  );
app.post("/api/auth/sso/register", ssoBlocked);
app.post("/api/auth/sso/delete-provider", ssoBlocked);

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// Everything under /api/v1 is gated until install completes.
app.use("/api/v1/*", installGate);
// Record all /api/v1 mutations (POST/PUT/PATCH/DELETE) for the audit trail.
// Best-effort: errors are swallowed inside the middleware; requests are never broken.
app.use("/api/v1/*", auditMiddleware);
app.route("/", me);
app.route("/", auditRoutes);
app.route("/", accessTokens);
app.route("/", usage);
app.route("/", orgOauthApps);
app.route("/", orgSecurity);
app.route("/", projects);
app.route("/", integrations);
app.route("/", orgSso);
