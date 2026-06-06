import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "../src/crypto/secrets";

describe("secrets", () => {
  it("round-trips plaintext", () => {
    const ct = encrypt("hunter2");
    expect(ct).not.toContain("hunter2");
    expect(decrypt(ct)).toBe("hunter2");
  });

  it("produces different ciphertext each time (random iv)", () => {
    expect(encrypt("x")).not.toBe(encrypt("x"));
  });

  it("throws on tampered ciphertext", () => {
    const ct = encrypt("secret");
    const tampered = ct.slice(0, -2) + (ct.endsWith("AA") ? "BB" : "AA");
    expect(() => decrypt(tampered)).toThrow();
  });
});
