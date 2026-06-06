import { describe, it, expect } from "vitest";
import {
  ORG_TYPES,
  DATA_PRIVACY_LEVELS,
  isOrgType,
  isDataPrivacyLevel,
  generateOrgSlug,
} from "../src/auth/org-fields";

describe("org-fields", () => {
  it("recognizes valid and invalid org types", () => {
    for (const t of ORG_TYPES) expect(isOrgType(t)).toBe(true);
    expect(isOrgType("enterprise")).toBe(false);
    expect(isOrgType(123)).toBe(false);
  });

  it("recognizes valid and invalid privacy levels", () => {
    for (const l of DATA_PRIVACY_LEVELS) expect(isDataPrivacyLevel(l)).toBe(true);
    expect(isDataPrivacyLevel("everything")).toBe(false);
  });

  it("generates unique 20-char lowercase slugs", () => {
    const a = generateOrgSlug();
    const b = generateOrgSlug();
    expect(a).toMatch(/^[a-z]{20}$/);
    expect(a).not.toBe(b);
  });
});
