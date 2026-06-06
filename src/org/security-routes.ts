import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { organization, member, user } from "../db/schema";
import { requireSession, requirePermission } from "../http/guards";
import { AppError } from "../http/error";

export const orgSecurity = new Hono();
const OWNER_ADMIN: Record<string, string[]> = { member: ["create"] };

orgSecurity.get("/api/v1/organizations/:orgId/security", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, OWNER_ADMIN);
  const [org] = await db.select({ mfaRequired: organization.mfaRequired }).from(organization).where(eq(organization.id, orgId));
  if (!org) throw new AppError(404, "organization_not_found", "Organization not found");
  const rows = await db
    .select({ userId: member.userId, email: user.email, mfaEnabled: user.twoFactorEnabled })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.organizationId, orgId));
  return c.json({ mfaRequired: !!org.mfaRequired, members: rows.map((r) => ({ userId: r.userId, email: r.email, mfaEnabled: !!r.mfaEnabled })) });
});

orgSecurity.put("/api/v1/organizations/:orgId/security", async (c) => {
  await requireSession(c);
  const orgId = c.req.param("orgId");
  await requirePermission(c, orgId, OWNER_ADMIN);
  const parsed = z.object({ mfaRequired: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError(400, "validation_error", "Invalid security payload", parsed.error.flatten());
  await db.update(organization).set({ mfaRequired: parsed.data.mfaRequired }).where(eq(organization.id, orgId));
  return c.json({ mfaRequired: parsed.data.mfaRequired });
});
