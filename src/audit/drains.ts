import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { auditLogDrain } from "../db/schema";
import type { AuditLogDrain } from "../db/schema";

export interface AuditEvent {
  actor_user_id: string | null;
  organization_id: string | null;
  method: string;
  path: string;
  status_code: number;
  timestamp: string;
}

// Map our row to the dashboard's LFBackend shape.
export function mapDrain(d: AuditLogDrain) {
  return {
    id: 0,
    token: d.id,
    name: d.name,
    description: d.description,
    type: d.type,
    config: d.config,
    enabled: d.enabled,
    inserted_at: d.createdAt.toISOString(),
    metadata: { type: "log-drain" as const },
  };
}

export async function listDrains(orgId: string) {
  const rows = await db.select().from(auditLogDrain).where(eq(auditLogDrain.organizationId, orgId));
  return rows.map(mapDrain);
}

export async function createDrain(
  orgId: string,
  input: { name: string; description?: string; type?: string; config: Record<string, unknown> }
) {
  const [row] = await db
    .insert(auditLogDrain)
    .values({
      organizationId: orgId,
      name: input.name,
      description: input.description ?? "",
      type: input.type ?? "webhook",
      config: input.config,
    })
    .returning();
  return mapDrain(row!);
}

export async function getDrain(token: string): Promise<AuditLogDrain | undefined> {
  const [row] = await db.select().from(auditLogDrain).where(eq(auditLogDrain.id, token));
  return row;
}

export async function updateDrain(
  token: string,
  patch: { name?: string; description?: string; config?: Record<string, unknown>; enabled?: boolean }
) {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof patch.name === "string") set.name = patch.name;
  if (typeof patch.description === "string") set.description = patch.description;
  if (patch.config) set.config = patch.config;
  if (typeof patch.enabled === "boolean") set.enabled = patch.enabled;
  const [row] = await db.update(auditLogDrain).set(set).where(eq(auditLogDrain.id, token)).returning();
  return row ? mapDrain(row) : null;
}

export async function deleteDrain(token: string): Promise<void> {
  await db.delete(auditLogDrain).where(eq(auditLogDrain.id, token));
}

async function postToWebhook(
  config: Record<string, unknown>,
  payload: unknown
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const url = typeof config.url === "string" ? config.url : "";
  if (!url) return { ok: false, error: "Drain has no URL configured" };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.headers && typeof config.headers === "object") {
    for (const [k, v] of Object.entries(config.headers as Record<string, unknown>)) {
      if (typeof v === "string") headers[k] = v;
    }
  }
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "request failed" };
  }
}

// Fire-and-forget delivery of an audit event to all enabled webhook drains of an org.
export async function deliverToDrains(orgId: string, event: AuditEvent): Promise<void> {
  const rows = await db
    .select()
    .from(auditLogDrain)
    .where(and(eq(auditLogDrain.organizationId, orgId), eq(auditLogDrain.enabled, true)));
  await Promise.allSettled(
    rows
      .filter((d) => d.type === "webhook")
      .map((d) => postToWebhook(d.config, { source: "audit_log", ...event }))
  );
}

export async function testDrain(token: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  const d = await getDrain(token);
  if (!d) return { ok: false, error: "Drain not found" };
  if (d.type !== "webhook") return { ok: false, error: `Backend type "${d.type}" is not supported on self-host yet` };
  return postToWebhook(d.config, {
    source: "audit_log",
    event: "test",
    message: "Test event from the Supabase console audit log drain",
    timestamp: new Date().toISOString(),
  });
}
