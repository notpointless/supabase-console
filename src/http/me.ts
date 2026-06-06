import { Hono } from "hono";
import { auth } from "../auth";
import { AppError } from "./error";

export const me = new Hono();
me.get("/api/v1/me", async (c) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    throw new AppError(401, "unauthenticated", "Not authenticated");
  }
  return c.json({ user: session.user, session: session.session });
});
