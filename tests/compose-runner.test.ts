import { describe, it, expect, afterEach } from "vitest";
import { getComposeRunner, setComposeRunner, resetComposeRunner, DockerComposeRunner, type ComposeRunner } from "../src/projects/stack/compose-runner";

describe("compose-runner", () => {
  afterEach(() => resetComposeRunner());

  it("defaults to the Docker runner", () => {
    expect(getComposeRunner()).toBeInstanceOf(DockerComposeRunner);
  });

  it("DockerComposeRunner builds the right docker compose argv", async () => {
    const calls: string[][] = [];
    const runner = new DockerComposeRunner(async (cmd, args) => { calls.push([cmd, ...args]); });
    await runner.up("/data/projects/abc", "sb-abc");
    expect(calls[0]![0]).toBe("docker");
    expect(calls[0]).toContain("compose");
    expect(calls[0]).toContain("-p");
    expect(calls[0]).toContain("sb-abc");
    expect(calls[0]!.join(" ")).toContain("/data/projects/abc/compose.yaml");
    expect(calls[0]!.join(" ")).toContain("/data/projects/abc/.env");
    expect(calls[0]).toContain("up");
    expect(calls[0]).toContain("-d");
  });

  it("can be overridden (test seam)", () => {
    const fake: ComposeRunner = { up: async () => {}, stop: async () => {}, start: async () => {}, down: async () => {}, restart: async () => {} };
    setComposeRunner(fake);
    expect(getComposeRunner()).toBe(fake);
  });
});
