/**
 * Account profile routes — /api/v1/account/profile and /api/v1/account/delete.
 *
 * GET  /api/v1/account/profile   → public profile (no password/hash fields)
 * PUT  /api/v1/account/profile   → update firstName/lastName/displayName/username
 * POST /api/v1/account/delete    → delete own account; blocked for platform admins
 *                                   and for users who still own projects.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { user, project } from "../db/schema";
import { requireSession } from "../http/guards";
import { AppError } from "../http/error";

export const accountProfile = new Hono();

// Columns that are safe to return in the public profile.
// NEVER include password/hash fields.
function toPublicProfile(row: typeof user.$inferSelect) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    firstName: row.firstName,
    lastName: row.lastName,
    displayName: row.displayName,
    username: row.username,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    isPlatformAdmin: row.role === "admin",
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/account/profile
// ---------------------------------------------------------------------------
accountProfile.get("/api/v1/account/profile", async (c) => {
  const session = await requireSession(c);
  const userId = session.user.id;

  const [row] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (!row) throw new AppError(404, "user_not_found", "User not found");

  return c.json(toPublicProfile(row));
});

// ---------------------------------------------------------------------------
// PUT /api/v1/account/profile
// ---------------------------------------------------------------------------
const updateSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  displayName: z.string().optional(),
  username: z.string().optional(),
});

accountProfile.put("/api/v1/account/profile", async (c) => {
  const session = await requireSession(c);
  const userId = session.user.id;

  const body = await c.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new AppError(400, "validation_error", "Invalid payload", parsed.error.flatten());
  }

  const { firstName, lastName, displayName, username } = parsed.data;

  await db
    .update(user)
    .set({ firstName, lastName, displayName, username })
    .where(eq(user.id, userId));

  const [updated] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (!updated) throw new AppError(404, "user_not_found", "User not found");

  return c.json(toPublicProfile(updated));
});

// ---------------------------------------------------------------------------
// POST /api/v1/account/delete
// ---------------------------------------------------------------------------
accountProfile.post("/api/v1/account/delete", async (c) => {
  const session = await requireSession(c);
  const userId = session.user.id;

  // Load the current user row so we have the role.
  const [row] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (!row) throw new AppError(404, "user_not_found", "User not found");

  // Platform admins (admin plugin role "admin") cannot be deleted.
  if (row.role === "admin") {
    throw new AppError(403, "cannot_delete_admin", "Admin accounts cannot be deleted");
  }

  // Block deletion if the user still owns projects (project.created_by is NOT NULL,
  // no cascade — deleting while projects exist would violate the FK constraint).
  const ownedProjects = await db
    .select({ id: project.id })
    .from(project)
    .where(eq(project.createdBy, userId))
    .limit(1);

  if (ownedProjects.length > 0) {
    throw new AppError(
      409,
      "user_owns_projects",
      "Cannot delete account while you still own projects. Transfer or delete your projects first.",
    );
  }

  // Delete the user. Sessions, accounts, members, invitations etc. cascade via FKs.
  await db.delete(user).where(eq(user.id, userId));

  return c.json({ ok: true });
});
