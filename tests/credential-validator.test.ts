import { describe, it, expect, afterEach } from "vitest";
import {
  getValidator,
  setValidator,
  resetValidator,
  StsValidator,
  type CredentialValidator,
} from "../src/aws/credential-validator";

describe("credential-validator", () => {
  afterEach(() => resetValidator());

  it("defaults to the STS validator", () => {
    expect(getValidator()).toBeInstanceOf(StsValidator);
  });

  it("can be overridden with a fake (test seam)", async () => {
    const fake: CredentialValidator = {
      validate: async () => ({ ok: true, accountId: "123456789012" }),
    };
    setValidator(fake);
    const res = await getValidator().validate({ accessKeyId: "A", secretAccessKey: "S", region: "us-west-2" });
    expect(res).toEqual({ ok: true, accountId: "123456789012" });
  });
});
