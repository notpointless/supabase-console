/**
 * Org-published OAuth apps surface for the console.
 *
 * The console is an OIDC provider (see `oidcProvider` in src/auth/auth.ts).
 * The plugin's `oauthApplication` table has NO organizationId column, so we
 * keep an own join table (`org_oauth_app`) mapping clientId → organizationId
 * to scope published apps to the org that created them.
 *
 * Security:
 *  - The client secret is returned EXACTLY ONCE, in the POST (create) response.
 *    List/get/authorized endpoints never select or echo `clientSecret`.
 *  - Authorization is enforced via our own `requirePermission` (which honours
 *    the "administrator" role), not the plugin's internal checks.
 *
 * Register API: we delegate creation to the oidc-provider plugin's
 * `auth.api.registerOAuthApplication` endpoint (RFC 7591 dynamic client
 * registration, POST /api/auth/oauth2/register). Body shape:
 *   { client_name, redirect_uris, logo_uri?, metadata? }
 * Response shape (server call returns the JSON body):
 *   { client_id, client_secret, redirect_uris, client_name, ... }
 * The plugin requires an authenticated session; we pass the request headers.
 *
 * Extra fields — stored via the register call (register-arg approach):
 *   - `logo`        → passed as `logo_uri`, stored in `oauthApplication.icon`
 *   - `website`     → stored inside `metadata` JSON as `{ website }`
 *   - `scopes`      → computed from `permissions` map; stored inside `metadata`
 *                     JSON as `{ scopes: string[] }`
 * Both `icon` and `metadata` columns exist on the better-auth
 * `oauthApplication` table and are written by the plugin's register handler.
 */
import { Hono } from "hono";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { auth } from "./index";
import { db } from "../db/client";
import { orgOauthApp, oauthApplication, oauthConsent } from "../db/schema";
import { requireSession, requirePermission } from "../http/guards";
import { AppError } from "../http/error";
import { OAUTH_SCOPE_RESOURCES, type OAuthAccess, permissionsToScopes } from "./oauth-scopes";

export const orgOauthApps = new Hono();

/** Permission required to register or delete an OAuth app (owner/admin). */
const OWNER_ADMIN: Record<string, string[]> = { member: ["create"] };

/** Permission required to list OAuth apps / authorized apps (any org member). */
const MEMBER: Record<string, string[]> = { project: ["content"] };

const registerSchema = z.object({
  name: z.string().min(1),
  redirectUrls: z.array(z.string().min(1)).min(1),
  website: z.string().url().optional(),
  logo: z.string().url().optional(),
  permissions: z.record(z.string(), z.enum(["none", "read", "write"])).optional(),
});

/** Shape of the RFC 7591 register response returned by the plugin. */
interface RegisterResult {
  client_id: string;
  client_secret?: string;
  client_name?: string;
}

/** Metadata blob stored in the `oauthApplication.metadata` column. */
interface StoredMeta {
  website?: string;
  scopes?: string[];
}

/** Split the plugin's comma-joined redirect_urls string into an array. */
function splitRedirects(value: string | null): string[] {
  if (!value) return [];
  return value.split(",").filter((s) => s.length > 0);
}

/** Parse the stored metadata JSON, returning a safe empty object on failure. */
function parseStoredMeta(raw: string | null | undefined): StoredMeta {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as StoredMeta;
  } catch {
    return {};
  }
}

/**
 * GET /api/v1/oauth-scopes
 * Returns the catalog of supported OAuth resource scopes.
 * Requires a valid session; no org permission check needed.
 */
orgOauthApps.get("/api/v1/oauth-scopes", async (c) => {
  await requireSession(c);
  return c.json({ resources: OAUTH_SCOPE_RESOURCES });
});

/**
 * POST /api/v1/organizations/:orgId/oauth-apps
 * Register a new OAuth app for the org. Returns the client secret ONCE.
 *
 * Optional extra fields:
 *   website     – marketing / home URL for the app
 *   logo        – logo image URL
 *   permissions – { [resourceId]: "none" | "read" | "write" } map
 *
 * `logo` is forwarded as `logo_uri` to the plugin (stored in `icon`).
 * `website` and computed `scopes` are encoded into the `metadata` JSON
 * blob and forwarded to the plugin (stored in `oauthApplication.metadata`).
 */
orgOauthApps.post("/api/v1/organizations/:orgId/oauth-apps", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, OWNER_ADMIN);

  const body = await c.req.json().catch(() => null);
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(400, "validation_error", "Invalid OAuth app payload", parsed.error.flatten());
  }

  const { name, redirectUrls, website, logo, permissions } = parsed.data;

  // Compute scopes from the permissions map.
  const scopes = permissionsToScopes((permissions ?? {}) as Record<string, OAuthAccess>);

  // Build the metadata blob we'll store in the oauthApplication row.
  const meta: StoredMeta = {};
  if (website !== undefined) meta.website = website;
  if (scopes.length > 0) meta.scopes = scopes;
  const hasMetadata = Object.keys(meta).length > 0;

  // Delegate creation to the oidc-provider plugin (RFC 7591). It generates
  // the clientId/clientSecret, hashes/stores the secret, and persists the
  // oauthApplication row. `logo_uri` → stored as `icon`; `metadata` → stored
  // as JSON string. The session is taken from the request headers.
  const result = (await auth.api.registerOAuthApplication({
    body: {
      client_name: name,
      redirect_uris: redirectUrls,
      ...(logo !== undefined ? { logo_uri: logo } : {}),
      ...(hasMetadata ? { metadata: meta as Record<string, unknown> } : {}),
    },
    headers: c.req.raw.headers,
  })) as RegisterResult;

  if (!result?.client_id) {
    throw new AppError(500, "oauth_register_failed", "App was not created");
  }

  // Bind the new app to its organisation via our own join table.
  await db.insert(orgOauthApp).values({ organizationId: orgId, clientId: result.client_id });

  // The secret is surfaced here and never again.
  return c.json({
    clientId: result.client_id,
    clientSecret: result.client_secret,
    name: result.client_name ?? name,
  });
});

/**
 * GET /api/v1/organizations/:orgId/oauth-apps
 * List the org's OAuth apps. NEVER returns clientSecret.
 * Returns: clientId, name, redirectUrls, logo, website, scopes.
 */
orgOauthApps.get("/api/v1/organizations/:orgId/oauth-apps", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, MEMBER);

  // Explicitly select only non-secret columns — clientSecret is never read.
  const rows = await db
    .select({
      clientId: orgOauthApp.clientId,
      name: oauthApplication.name,
      redirectUrls: oauthApplication.redirectUrls,
      icon: oauthApplication.icon,
      metadata: oauthApplication.metadata,
    })
    .from(orgOauthApp)
    .innerJoin(oauthApplication, eq(orgOauthApp.clientId, oauthApplication.clientId))
    .where(eq(orgOauthApp.organizationId, orgId));

  return c.json({
    apps: rows.map((r) => {
      const storedMeta = parseStoredMeta(r.metadata);
      return {
        clientId: r.clientId,
        name: r.name,
        redirectUrls: splitRedirects(r.redirectUrls),
        logo: r.icon ?? undefined,
        website: storedMeta.website ?? undefined,
        scopes: storedMeta.scopes ?? [],
      };
    }),
  });
});

/**
 * GET /api/v1/organizations/:orgId/oauth-apps/authorized
 * List the current user's authorized apps (consents). No secrets.
 */
orgOauthApps.get("/api/v1/organizations/:orgId/oauth-apps/authorized", async (c) => {
  const session = await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, MEMBER);

  // Restrict to apps published by this org so the list is org-scoped.
  const orgApps = await db
    .select({ clientId: orgOauthApp.clientId })
    .from(orgOauthApp)
    .where(eq(orgOauthApp.organizationId, orgId));
  const orgClientIds = orgApps.map((a) => a.clientId);
  if (orgClientIds.length === 0) return c.json({ apps: [] });

  const rows = await db
    .select({
      clientId: oauthConsent.clientId,
      scopes: oauthConsent.scopes,
      name: oauthApplication.name,
    })
    .from(oauthConsent)
    .innerJoin(oauthApplication, eq(oauthConsent.clientId, oauthApplication.clientId))
    .where(
      and(
        eq(oauthConsent.userId, session.user.id),
        inArray(oauthConsent.clientId, orgClientIds),
      ),
    );

  return c.json({
    apps: rows.map((r) => ({
      clientId: r.clientId,
      name: r.name,
      scopes: r.scopes,
    })),
  });
});

/**
 * DELETE /api/v1/organizations/:orgId/oauth-apps/:clientId
 * Remove an OAuth app the org owns (app row + join link).
 */
orgOauthApps.delete("/api/v1/organizations/:orgId/oauth-apps/:clientId", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, OWNER_ADMIN);
  const clientId = c.req.param("clientId");

  // Verify the app belongs to this org before deleting anything.
  const [link] = await db
    .select()
    .from(orgOauthApp)
    .where(and(eq(orgOauthApp.organizationId, orgId), eq(orgOauthApp.clientId, clientId)));
  if (!link) {
    throw new AppError(404, "not_found", "OAuth app not found");
  }

  // Atomic: drop the app row and the org link together (no orphaned link on partial failure).
  await db.transaction(async (tx) => {
    await tx.delete(oauthApplication).where(eq(oauthApplication.clientId, clientId));
    await tx.delete(orgOauthApp).where(eq(orgOauthApp.clientId, clientId));
  });

  return c.json({ ok: true });
});
