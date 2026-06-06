import { createMiddleware } from "hono/factory";
import { isInstalled } from "../install/status";
import { AppError } from "./error";

// Applied to /api/v1/*. Returns 409 before install so the UI redirects to setup.
export const installGate = createMiddleware(async (c, next) => {
  if (!(await isInstalled())) {
    throw new AppError(409, "not_installed", "Instance is not installed");
  }
  return next();
});
