import type { Context } from "hono";
import { auth } from "../auth";
import { AppError } from "./error";

export async function requireSession(c: Context) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new AppError(401, "unauthenticated", "Not authenticated");
  return session;
}

export async function requirePermission(
  c: Context,
  organizationId: string,
  permissions: Record<string, string[]>,
): Promise<void> {
  try {
    const res = await auth.api.hasPermission({
      headers: c.req.raw.headers,
      body: { organizationId, permissions },
    });
    if (!res.success) throw new AppError(403, "forbidden", "You do not have permission");
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(403, "forbidden", "You do not have permission");
  }
}
