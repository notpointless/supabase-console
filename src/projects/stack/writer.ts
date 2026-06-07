import { mkdirSync, writeFileSync, rmSync, cpSync, readdirSync, readFileSync, statSync } from "node:fs";
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

// Normalize CRLF -> LF for text files in the vendored volumes. On Windows
// checkouts git may materialize these scripts/configs with CRLF, which breaks
// container exec of shebang scripts (e.g. kong-entrypoint.sh -> "no such file
// or directory"). On Linux the files are already LF, so this is a no-op.
// Binary files (detected via a NUL byte) are left untouched.
function normalizeLineEndings(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      normalizeLineEndings(full);
    } else if (entry.isFile()) {
      if (statSync(full).size > 5_000_000) continue; // skip large/binary blobs
      const buf = readFileSync(full);
      if (buf.includes(0)) continue; // binary
      if (!buf.includes(0x0d)) continue; // no CR, nothing to do (Linux path)
      writeFileSync(full, buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
    }
  }
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
  // Ensure shell scripts / configs use LF so Linux containers can exec them.
  normalizeLineEndings(join(dir, "volumes"));
  return dir;
}

export function removeStack(ref: string): void {
  rmSync(projectDir(ref), { recursive: true, force: true });
}
