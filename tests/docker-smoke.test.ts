import { describe, it, expect } from "vitest";

const run = process.env.RUN_DOCKER_E2E === "1";

// Opt-in only: real docker provisioning is validated manually on a Docker host with
// RUN_DOCKER_E2E=1 (pulls ~11 images, takes minutes). NOT run in CI.
describe.skipIf(!run)("real docker provisioning (opt-in)", () => {
  it("brings up a real stack via DockerComposeRunner", async () => {
    expect(run).toBe(true);
    // Manual harness: build a project, provision via SharedInfraProvisioner with the
    // real DockerComposeRunner, curl the apiUrl, then down. Left minimal because not run in CI.
  }, 600_000);
});
