/**
 * Canonical SSO management surface for the console.
 *
 * Why these routes exist (and the plugin's native routes are blocked):
 *
 * 1. Role-name mismatch — the @better-auth/sso plugin's internal `hasOrgAdminRole`
 *    helper grants access only to roles named "owner" or "admin".  Our org admin
 *    role is named "administrator" (see src/auth/permissions.ts), so the plugin
 *    would permanently deny administrator users.  These routes authorize via our
 *    own `requirePermission`, which correctly honours the "administrator" role.
 *
 * 2. Secret echo — the plugin's POST /api/auth/sso/register returns the full
 *    provider record including cert / clientSecret / privateKey fields.  Our
 *    `publicProvider` helper strips those before responding.  Both plugin routes
 *    (POST /api/auth/sso/register and POST /api/auth/sso/delete-provider) are
 *    blocked at the app level (src/app.ts) so clients cannot reach them.
 *
 * Known gap: `ssoProvider.organizationId` has no DB foreign-key constraint to
 * the `organization` table (the column is plugin-generated).  Providers are
 * therefore NOT cascade-deleted when their org is removed — this is a minor
 * hygiene issue to revisit when we add org-deletion support.
 */
import { Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { auth } from "./index";
import { db } from "../db/client";
import { ssoProvider } from "../db/schema";
import { requireSession, requirePermission } from "../http/guards";
import { AppError } from "../http/error";

export const orgSso = new Hono();

/** Permission required to register or delete an SSO provider (owner/admin). */
const OWNER_ADMIN: Record<string, string[]> = { member: ["create"] };

/** Permission required to list SSO providers (any org member). */
const MEMBER: Record<string, string[]> = { project: ["content"] };

/**
 * Loose schema for our API layer.
 * The @better-auth/sso plugin enforces the detailed structure at runtime;
 * we only enforce the outer envelope here.
 */
const registerSchema = z.object({
  providerId: z.string().min(1),
  issuer: z.string().min(1),
  domain: z.string().min(1),
  // Accept any object for the provider configs — the SSO plugin validates details.
  samlConfig: z.record(z.string(), z.any()).optional(),
  oidcConfig: z.record(z.string(), z.any()).optional(),
});

type SsoRow = typeof ssoProvider.$inferSelect;

/** Returns only the public (non-secret) fields from a stored SSO provider row. */
function publicProvider(p: SsoRow) {
  return {
    providerId: p.providerId,
    issuer: p.issuer,
    domain: p.domain,
    organizationId: p.organizationId,
  };
}

/** POST /api/v1/organizations/:orgId/sso — register a new SSO provider. */
orgSso.post("/api/v1/organizations/:orgId/sso", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, OWNER_ADMIN);

  const body = await c.req.json().catch(() => null);
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(400, "validation_error", "Invalid SSO payload", parsed.error.flatten());
  }
  if (!parsed.data.samlConfig && !parsed.data.oidcConfig) {
    throw new AppError(400, "validation_error", "samlConfig or oidcConfig required");
  }

  // Delegate to the @better-auth/sso plugin for config validation,
  // provider-limit enforcement, and persistence.
  //
  // We intentionally omit organizationId from the plugin body.  The plugin's
  // internal hasOrgAdminRole check only recognises "owner" and "admin" roles,
  // not our "administrator" role.  We have already authorised the caller via
  // requirePermission above, so skipping that secondary check is correct.
  // organizationId is patched onto the stored row by the UPDATE below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await auth.api.registerSSOProvider({ body: parsed.data as any, headers: c.req.raw.headers });

  // Bind the newly-created provider row to its organisation.
  await db
    .update(ssoProvider)
    .set({ organizationId: orgId })
    .where(eq(ssoProvider.providerId, parsed.data.providerId));

  // Fetch the stored row so we control which fields are returned.
  const [row] = await db
    .select()
    .from(ssoProvider)
    .where(
      and(
        eq(ssoProvider.organizationId, orgId),
        eq(ssoProvider.providerId, parsed.data.providerId),
      ),
    );
  if (!row) {
    throw new AppError(500, "sso_register_failed", "Provider was not stored");
  }
  return c.json(publicProvider(row));
});

/** GET /api/v1/organizations/:orgId/sso — list SSO providers (no secrets). */
orgSso.get("/api/v1/organizations/:orgId/sso", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, MEMBER);

  const rows = await db
    .select()
    .from(ssoProvider)
    .where(eq(ssoProvider.organizationId, orgId));

  return c.json({ providers: rows.map(publicProvider) });
});

/** DELETE /api/v1/organizations/:orgId/sso/:providerId — remove an SSO provider. */
orgSso.delete("/api/v1/organizations/:orgId/sso/:providerId", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, OWNER_ADMIN);

  await db
    .delete(ssoProvider)
    .where(
      and(
        eq(ssoProvider.organizationId, orgId),
        eq(ssoProvider.providerId, c.req.param("providerId")),
      ),
    );

  return c.json({ ok: true });
});
