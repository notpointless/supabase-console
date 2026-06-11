import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { project, type Project } from "../db/schema";
import { AppError } from "../http/error";
import { assertPublicHttpsUrl } from "../http/url-guard";

// [console fork] Third-Party Auth: register external JWT issuers (Firebase, Auth0, Cognito,
// any OIDC provider) so the project's data API will VERIFY tokens they sign. Supabase stores
// these in its platform DB; we store them on the project (project.third_party_auth) so the
// resolved issuer JWKS can be merged into the stack's verify key set by buildStack — applied
// to the running stack on reconfigure (works on shared + EC2). Persisted regardless, so it
// survives pause/stop/resume and re-applies on the next provision.
//
// Scope note: this wires SIGNATURE verification (the issuer's keys join the JWKS every stack
// service trusts). For an external token to also assume a Postgres role, it must carry the
// usual `role` claim (or your PostgREST role-claim mapping) — the same requirement Supabase's
// hosted third-party auth documents.

export interface ThirdPartyAuthIntegration {
  id: string;
  type: string; // "oidc" | "jwks" | "custom"
  oidc_issuer_url: string | null;
  jwks_url: string | null;
  custom_jwks: unknown | null;
  resolved_jwks: { keys: unknown[] };
  inserted_at: string;
  updated_at: string;
}

export function listThirdPartyAuth(p: Project): ThirdPartyAuthIntegration[] {
  const v = p.thirdPartyAuth as ThirdPartyAuthIntegration[] | null;
  return Array.isArray(v) ? v : [];
}

interface TpaInput {
  oidc_issuer_url?: string;
  jwks_url?: string;
  custom_jwks?: unknown;
}

// Resolve the issuer's JWKS: an inline custom JWKS wins; else a direct JWKS URL; else OIDC
// discovery from the issuer URL. Returns the verify key set to merge into the stack.
async function resolveJwks(input: TpaInput): Promise<{ keys: unknown[] }> {
  if (input.custom_jwks && typeof input.custom_jwks === "object") {
    const ck = input.custom_jwks as { keys?: unknown };
    if (Array.isArray(ck.keys)) return { keys: ck.keys };
    return { keys: [input.custom_jwks] }; // a single bare JWK
  }

  let jwksUrl = input.jwks_url;
  if (!jwksUrl && input.oidc_issuer_url) {
    const disc = input.oidc_issuer_url.replace(/\/+$/, "") + "/.well-known/openid-configuration";
    assertPublicHttpsUrl(disc);
    const r = await fetch(disc).catch(() => null);
    const j = r && r.ok ? ((await r.json().catch(() => null)) as { jwks_uri?: string } | null) : null;
    jwksUrl = j?.jwks_uri;
    if (!jwksUrl) {
      throw new AppError(400, "discovery_failed", "Could not discover a JWKS URL from that issuer");
    }
  }
  if (!jwksUrl) {
    throw new AppError(400, "missing_jwks", "Provide an OIDC issuer URL, a JWKS URL, or a custom JWKS");
  }

  // Validate even a discovery-supplied jwks_uri (a hostile issuer could point it inward).
  assertPublicHttpsUrl(jwksUrl);
  const r = await fetch(jwksUrl).catch(() => null);
  if (!r || !r.ok) throw new AppError(400, "jwks_fetch_failed", `Could not fetch the JWKS from ${jwksUrl}`);
  const j = (await r.json().catch(() => null)) as { keys?: unknown } | null;
  if (!Array.isArray(j?.keys)) {
    throw new AppError(400, "invalid_jwks", "That JWKS endpoint did not return a valid key set");
  }
  return { keys: j.keys };
}

export async function addThirdPartyAuth(p: Project, body: TpaInput): Promise<ThirdPartyAuthIntegration> {
  if (!body.oidc_issuer_url && !body.jwks_url && !body.custom_jwks) {
    throw new AppError(400, "missing_input", "Provide an OIDC issuer URL, a JWKS URL, or a custom JWKS");
  }
  const resolved = await resolveJwks(body);
  const now = new Date().toISOString();
  const integration: ThirdPartyAuthIntegration = {
    id: randomUUID(),
    type: body.oidc_issuer_url ? "oidc" : body.jwks_url ? "jwks" : "custom",
    oidc_issuer_url: body.oidc_issuer_url ?? null,
    jwks_url: body.jwks_url ?? null,
    custom_jwks: body.custom_jwks ?? null,
    resolved_jwks: resolved,
    inserted_at: now,
    updated_at: now,
  };
  const list = [...listThirdPartyAuth(p), integration];
  await db.update(project).set({ thirdPartyAuth: list, updatedAt: new Date() }).where(eq(project.id, p.id));
  return integration;
}

export async function deleteThirdPartyAuth(p: Project, id: string): Promise<void> {
  const list = listThirdPartyAuth(p).filter((i) => i.id !== id);
  await db.update(project).set({ thirdPartyAuth: list, updatedAt: new Date() }).where(eq(project.id, p.id));
}

/** All configured issuers' JWKS keys, for merging into the stack's verify set (buildStack). */
export function thirdPartyJwkKeys(p: Project): unknown[] {
  return listThirdPartyAuth(p).flatMap((i) => i.resolved_jwks?.keys ?? []);
}
