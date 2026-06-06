import { describe, it, expect, afterEach } from "vitest";
import { getProvisioner, setProvisioner, resetProvisioner, StubProvisioner } from "../src/projects/provisioner";

const fakeProject = { ref: "abc", region: "shared", infrastructureType: "shared" } as never;

describe("provisioner", () => {
  afterEach(() => resetProvisioner());

  it("defaults to the stub", () => {
    expect(getProvisioner()).toBeInstanceOf(StubProvisioner);
  });

  it("stub returns a fake connection from provision()", async () => {
    const res = await new StubProvisioner().provision(fakeProject);
    expect(res.connection.ref).toBe("abc");
    expect(res.connection.host).toContain("abc");
    expect(res.connection.port).toBe(5432);
  });

  it("can be overridden", () => {
    const fake = { provision: async () => ({ connection: { host: "h", port: 1, ref: "r" } }), pause: async () => {}, resume: async () => {}, delete: async () => {} };
    setProvisioner(fake);
    expect(getProvisioner()).toBe(fake);
  });
});
