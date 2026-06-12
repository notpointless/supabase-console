import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { orgAiConfig } from "../db/schema";
import { encrypt, decrypt } from "../crypto/secrets";
import { requireSession, requirePermission } from "../http/guards";
import { AppError } from "../http/error";

// [console fork] Per-organization AI assistant config — the org's own OpenAI API key. The key is
// encrypted at rest and NEVER returned to the browser (status is a boolean); it is decrypted only
// server-side for the studio's AI routes (the /key endpoint, consumed BFF-style with the session
// cookie). Setting/clearing the key is an admin operation; reading status / the key / the model
// list is available to any member (so the assistant works for everyone in the org).
export const aiConfig = new Hono();

// Members can use the assistant (and thus the key); admins manage it.
const MEMBER: Record<string, string[]> = { project: ["content"] };
const ADMIN: Record<string, string[]> = { member: ["create"] };

const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

async function loadKey(orgId: string): Promise<string | null> {
  const [row] = await db.select().from(orgAiConfig).where(eq(orgAiConfig.organizationId, orgId));
  return row ? decrypt(row.openaiApiKeyEncrypted) : null;
}

// GET status — { configured, updatedAt }. Never the raw key.
aiConfig.get("/api/v1/organizations/:orgId/ai-config", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, MEMBER);
  const [row] = await db.select().from(orgAiConfig).where(eq(orgAiConfig.organizationId, orgId));
  return c.json({ configured: !!row, updatedAt: row?.updatedAt ?? null });
});

// PUT — set/replace the org's OpenAI key (admin only).
aiConfig.put("/api/v1/organizations/:orgId/ai-config", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, ADMIN);
  const body = (await c.req.json().catch(() => ({}))) as { openaiApiKey?: unknown };
  const key = typeof body.openaiApiKey === "string" ? body.openaiApiKey.trim() : "";
  // OpenAI keys are `sk-...` (incl. `sk-proj-...`); basic shape check to catch obvious mistakes.
  if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) {
    throw new AppError(400, "invalid_key", "Enter a valid OpenAI API key (starts with 'sk-')");
  }
  const encrypted = encrypt(key);
  await db
    .insert(orgAiConfig)
    .values({ organizationId: orgId, openaiApiKeyEncrypted: encrypted })
    .onConflictDoUpdate({
      target: orgAiConfig.organizationId,
      set: { openaiApiKeyEncrypted: encrypted, updatedAt: new Date() },
    });
  return c.json({ configured: true });
});

// DELETE — clear the org's key (admin only).
aiConfig.delete("/api/v1/organizations/:orgId/ai-config", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, ADMIN);
  await db.delete(orgAiConfig).where(eq(orgAiConfig.organizationId, orgId));
  return c.json({ configured: false });
});

// INTERNAL — the decrypted key, for the studio's server-side AI routes only (BFF, session cookie
// forwarded). Member-level: a member who can use the assistant uses the key, but the key is never
// surfaced to the browser by the studio (it's used to call OpenAI server-side).
aiConfig.get("/api/v1/organizations/:orgId/ai-config/key", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, MEMBER);
  const key = await loadKey(orgId);
  return c.json({ openaiApiKey: key });
});

// GET models — list the org's available OpenAI models (dynamic model picker). Uses the org key
// server-side; returns only model ids, sorted, with the chat-capable ones first.
aiConfig.get("/api/v1/organizations/:orgId/ai-config/models", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, MEMBER);
  const key = await loadKey(orgId);
  if (!key) return c.json({ models: [] });
  try {
    const res = await fetch(OPENAI_MODELS_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AppError(res.status === 401 ? 400 : 502, "openai_error", `OpenAI: ${text.slice(0, 200) || res.statusText}`);
    }
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string")
      // Chat/completion-capable models the assistant can use; drop embeddings/audio/image/etc.
      .filter((id) => /^(gpt|o[0-9]|chatgpt)/i.test(id) && !/(embedding|whisper|tts|dall-e|image|audio|moderation|realtime|transcribe)/i.test(id))
      .sort();
    return c.json({ models: ids });
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(502, "openai_unreachable", e instanceof Error ? e.message : "Could not reach OpenAI");
  }
});
