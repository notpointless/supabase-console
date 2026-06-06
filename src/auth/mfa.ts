import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { organization, user } from "../db/schema";
import { auth } from "./index";
import { AppError } from "../http/error";

// Throws 403 mfa_required if the org enforces MFA and the current user lacks 2FA.
export async function assertMfaCompliant(c: Context, organizationId: string): Promise<void> {
  const [org] = await db.select({ mfaRequired: organization.mfaRequired }).from(organization).where(eq(organization.id, organizationId));
  if (!org?.mfaRequired) return;
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new AppError(401, "unauthenticated", "Not authenticated");
  const [u] = await db.select({ twoFactorEnabled: user.twoFactorEnabled }).from(user).where(eq(user.id, session.user.id));
  if (!u?.twoFactorEnabled) {
    throw new AppError(403, "mfa_required", "This organization requires two-factor authentication");
  }
}
