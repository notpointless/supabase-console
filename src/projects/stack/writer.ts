import { mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getEnv } from "../../config/env";

const VOLUMES_SRC = join(dirname(fileURLToPath(import.meta.url)), "volumes");

export function projectDir(ref: string): string {
  return join(getEnv().DATA_DIR, "projects", ref);
}

function renderEnv(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

export function writeStack(
  ref: string,
  stack: { composeYaml: string; env: Record<string, string> },
): string {
  const dir = projectDir(ref);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "compose.yaml"), stack.composeYaml, "utf8");
  writeFileSync(join(dir, ".env"), renderEnv(stack.env), "utf8");
  cpSync(VOLUMES_SRC, join(dir, "volumes"), { recursive: true });
  return dir;
}

export function removeStack(ref: string): void {
  rmSync(projectDir(ref), { recursive: true, force: true });
}
