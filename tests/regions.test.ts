import { describe, it, expect } from "vitest";
import { availableRegions, isEc2Region, isKnownRegion, SHARED_REGION } from "../src/regions";

describe("regions", () => {
  it("returns only shared when no creds", () => {
    const r = availableRegions(false);
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe(SHARED_REGION.id);
  });
  it("returns shared + ec2 regions with creds", () => {
    const r = availableRegions(true);
    expect(r.length).toBeGreaterThan(1);
    expect(r.some((x) => x.id === "us-west-2")).toBe(true);
  });
  it("classifies regions", () => {
    expect(isEc2Region("us-west-2")).toBe(true);
    expect(isEc2Region("shared")).toBe(false);
    expect(isKnownRegion("shared")).toBe(true);
    expect(isKnownRegion("mars-1")).toBe(false);
  });
});
