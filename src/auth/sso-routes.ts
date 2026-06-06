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

  // Delegate to the @better-auth/sso plugin which handles config validation,
  // provider-limit enforcement, and persistence.
  // We cast the body because the plugin validates the detailed structure at runtime.
  await auth.api.registerSSOProvider({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: { ...parsed.data, organizationId: orgId } as any,
    headers: c.req.raw.headers,
  });

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
