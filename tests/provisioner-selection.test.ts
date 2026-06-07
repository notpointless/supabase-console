import { describe, it, expect, beforeEach } from "vitest";
import { getProvisionerFor, resetProvisioner } from "../src/projects/provisioner";
import { SharedInfraProvisioner } from "../src/projects/shared-infra-provisioner";
import { Ec2Provisioner } from "../src/projects/ec2-provisioner";

describe("provisioner selection", () => {
  beforeEach(() => resetProvisioner());

  it("shared infrastructure uses the local compose provisioner", () => {
    const p = getProvisionerFor({ infrastructureType: "shared" });
    expect(p).toBeInstanceOf(SharedInfraProvisioner);
  });

  it("dedicated EC2 uses the real EC2 server provisioner (not a container)", () => {
    const p = getProvisionerFor({ infrastructureType: "dedicated_ec2" });
    expect(p).toBeInstanceOf(Ec2Provisioner);
  });
});
