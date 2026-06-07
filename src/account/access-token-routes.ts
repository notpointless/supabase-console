/**
 * Personal Access Tokens (PATs) for /api/v1 auth.
 *
 * Delegated entirely to better-auth's apiKey plugin. The plugin is configured
 * in src/auth/auth.ts with `enableMetadata: true` and `defaultPrefix: "sbp_"`.
 *
 * Security contract:
 *  - The raw token is returned EXACTLY ONCE, in the POST (create) response
 *    as `token`. The plugin stores only the hashed value (`key` column).
 *  - List and second-GET responses are built from the plugin's `listApiKeys`
 *    API, which strips `key` from every returned item.
 *  - Ownership is scoped by the plugin: `deleteApiKey` returns NOT_FOUND when
 *    the session user does not own the key.
 *
 * Plugin server-API shapes (verified in node_modules/@better-auth/api-key):
 *   auth.api.createApiKey({ body: { name, expiresIn, prefix, metadata }, headers })
 *     → { id, key (RAW, only at create), name, start, prefix, expiresAt, createdAt, ... }
 *   auth.api.listApiKeys({ headers })
 *     → { apiKeys: Omit<ApiKey,"key">[], total, ... }
 *   auth.api.deleteApiKey({ body: { keyId }, headers })
 *     → { success: true }  (throws APIError NOT_FOUND if user doesn't own the key)
 */
import { Hono } from "hono";
import { z } from "zod";
import { auth } from "../auth";
import { requireSession } from "../http/guards";
import { AppError } from "../http/error";

export const accessTokens = new Hono();

const createSchema = z.object({
  name: z.string().min(1),
  expiresInDays: z.number().int().positive().default(30),
  type: z.enum(["classic", "experimental"]).default("classic"),
});

// ---------------------------------------------------------------------------
// POST /api/v1/account/access-tokens
// Create a new PAT for the authenticated user. Returns the raw token ONCE.
// ---------------------------------------------------------------------------
accessTokens.post("/api/v1/account/access-tokens", async (c) => {
  await requireSession(c);

  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(400, "validation_error", "Invalid payload", parsed.error.flatten());
  }

  const { name, expiresInDays, type } = parsed.data;

  // Delegate to the apiKey plugin. When session headers are present the plugin
  // resolves the userId from the session — no need to pass it explicitly.
  const result = (await auth.api.createApiKey({
    body: {
      name,
      expiresIn: expiresInDays * 86400,
      prefix: "sbp_",
      metadata: { type },
    },
    headers: c.req.raw.headers,
  })) as {
    id: string;
    key: string; // RAW key — only available in the create response
    name: string | null;
    start: string | null;
    prefix: string | null;
    expiresAt: Date | null;
    createdAt: Date;
  };

  // `result.key` is the raw token returned once by the plugin.
  return c.json({
    id: result.id,
    name: result.name ?? name,
    token: result.key,
    type,
    expiresAt: result.expiresAt,
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/account/access-tokens
// List the current user's PATs. NEVER returns the raw token or the hashed key.
// ---------------------------------------------------------------------------
accessTokens.get("/api/v1/account/access-tokens", async (c) => {
  await requireSession(c);

  const result = (await auth.api.listApiKeys({
    headers: c.req.raw.headers,
  })) as {
    apiKeys: Array<{
      id: string;
      name: string | null;
      start: string | null;
      prefix: string | null;
      createdAt: Date;
      expiresAt: Date | null;
      metadata: Record<string, unknown> | null;
    }>;
  };

  // Map to our public shape: never include `key` (hashed) or the raw token.
  return c.json(
    result.apiKeys.map((k) => ({
      id: k.id,
      name: k.name,
      start: k.start,
      prefix: k.prefix,
      type: (k.metadata as { type?: string } | null)?.type ?? "classic",
      createdAt: k.createdAt,
      expiresAt: k.expiresAt,
    })),
  );
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/account/access-tokens/:id
// Delete a PAT owned by the current user.
// The plugin automatically scopes deletion to the session user — if the key
// belongs to a different user the plugin returns NOT_FOUND.
// ---------------------------------------------------------------------------
accessTokens.delete("/api/v1/account/access-tokens/:id", async (c) => {
  await requireSession(c);
  const keyId = c.req.param("id");

  try {
    await auth.api.deleteApiKey({
      body: { keyId },
      headers: c.req.raw.headers,
    });
  } catch (e) {
    // Convert plugin's APIError (better-call) to AppError for Hono's onError.
    // The better-call APIError carries a numeric `statusCode` property.
    if (e != null && typeof e === "object" && "statusCode" in e) {
      const err = e as { statusCode: number; message?: string; body?: unknown };
      const bodyMsg =
        err.body != null &&
        typeof err.body === "object" &&
        "message" in err.body &&
        typeof (err.body as { message?: unknown }).message === "string"
          ? (err.body as { message: string }).message
          : undefined;
      throw new AppError(
        err.statusCode,
        "api_key_error",
        bodyMsg ?? err.message ?? "API key operation failed",
      );
    }
    throw e;
  }

  return c.json({ ok: true });
});

// ===========================================================================
// Scoped access tokens (/platform/profile/scoped-access-tokens). Same apiKey
// plugin, but the scopes (permissions + org/project restrictions) live in the
// key's metadata. Token is returned raw exactly once on create.
// ===========================================================================
const scopedCreateSchema = z.object({
  name: z.string().min(1),
  expires_at: z.string().datetime().optional(),
  organization_slugs: z.array(z.string()).optional(),
  project_refs: z.array(z.string()).optional(),
  permissions: z.array(z.string()).default([]),
});

interface ScopedMeta {
  scoped: true;
  permissions: string[];
  organization_slugs?: string[];
  project_refs?: string[];
}

function aliasOf(k: { start: string | null; prefix: string | null }): string {
  return k.start ? `${k.start}…` : `${k.prefix ?? "sbp_"}…`;
}

accessTokens.post("/api/v1/account/scoped-access-tokens", async (c) => {
  await requireSession(c);
  const parsed = scopedCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new AppError(400, "validation_error", "Invalid payload", parsed.error.flatten());
  }
  const { name, expires_at, organization_slugs, project_refs, permissions } = parsed.data;
  const expiresIn = expires_at
    ? Math.max(60, Math.floor((new Date(expires_at).getTime() - Date.now()) / 1000))
    : undefined;

  const metadata: ScopedMeta = { scoped: true, permissions, organization_slugs, project_refs };
  const result = (await auth.api.createApiKey({
    body: { name, expiresIn, prefix: "sbp_", metadata },
    headers: c.req.raw.headers,
  })) as {
    id: string;
    key: string;
    name: string | null;
    start: string | null;
    prefix: string | null;
    expiresAt: Date | null;
    createdAt: Date;
  };

  return c.json({
    id: result.id,
    name: result.name ?? name,
    token: result.key,
    token_alias: aliasOf(result),
    created_at: result.createdAt,
    expires_at: result.expiresAt,
    last_used_at: null,
    permissions,
    organization_slugs: organization_slugs ?? [],
    project_refs: project_refs ?? [],
  });
});

function mapScoped(k: {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  lastRequest?: Date | null;
  metadata: Record<string, unknown> | null;
}) {
  const meta = (k.metadata ?? {}) as Partial<ScopedMeta>;
  return {
    id: k.id,
    name: k.name,
    token_alias: aliasOf(k),
    created_at: k.createdAt,
    expires_at: k.expiresAt,
    last_used_at: k.lastRequest ?? null,
    permissions: meta.permissions ?? [],
    organization_slugs: meta.organization_slugs ?? [],
    project_refs: meta.project_refs ?? [],
  };
}

accessTokens.get("/api/v1/account/scoped-access-tokens", async (c) => {
  await requireSession(c);
  const result = (await auth.api.listApiKeys({ headers: c.req.raw.headers })) as {
    apiKeys: Array<Parameters<typeof mapScoped>[0] & { metadata: Record<string, unknown> | null }>;
  };
  const scoped = result.apiKeys.filter(
    (k) => (k.metadata as { scoped?: boolean } | null)?.scoped === true,
  );
  return c.json(scoped.map(mapScoped));
});

accessTokens.get("/api/v1/account/scoped-access-tokens/:id", async (c) => {
  await requireSession(c);
  const id = c.req.param("id");
  const result = (await auth.api.listApiKeys({ headers: c.req.raw.headers })) as {
    apiKeys: Array<Parameters<typeof mapScoped>[0] & { metadata: Record<string, unknown> | null }>;
  };
  const k = result.apiKeys.find((x) => x.id === id);
  if (!k || (k.metadata as { scoped?: boolean } | null)?.scoped !== true) {
    throw new AppError(404, "not_found", "Token not found");
  }
  return c.json(mapScoped(k));
});

accessTokens.delete("/api/v1/account/scoped-access-tokens/:id", async (c) => {
  await requireSession(c);
  const keyId = c.req.param("id");
  try {
    await auth.api.deleteApiKey({ body: { keyId }, headers: c.req.raw.headers });
  } catch (e) {
    if (e != null && typeof e === "object" && "statusCode" in e) {
      const err = e as { statusCode: number; message?: string };
      throw new AppError(err.statusCode, "api_key_error", err.message ?? "API key operation failed");
    }
    throw e;
  }
  return c.json({ ok: true });
});
