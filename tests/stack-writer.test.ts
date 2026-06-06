import { describe, it, expect, afterEach } from "vitest";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeStack, removeStack, projectDir } from "../src/projects/stack/writer";

const ref = "writezz" + Math.random().toString(36).slice(2, 8);

describe("stack writer", () => {
  afterEach(() => { try { rmSync(projectDir(ref), { recursive: true, force: true }); } catch { /* ignore */ } });

  it("writes compose.yaml, .env, and the volumes tree", () => {
    const dir = writeStack(ref, { composeYaml: "name: sb\nservices: {}\n", env: { JWT_SECRET: "s", FOO: "bar" } });
    expect(existsSync(join(dir, "compose.yaml"))).toBe(true);
    expect(existsSync(join(dir, ".env"))).toBe(true);
    expect(existsSync(join(dir, "volumes"))).toBe(true);
    const envText = readFileSync(join(dir, ".env"), "utf8");
    expect(envText).toContain("JWT_SECRET=s");
    expect(envText).toContain("FOO=bar");
  });

  it("removeStack deletes the dir", () => {
    const dir = writeStack(ref, { composeYaml: "name: sb\n", env: {} });
    removeStack(ref);
    expect(existsSync(dir)).toBe(false);
  });
});
