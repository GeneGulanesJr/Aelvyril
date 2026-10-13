import { describe, expect, it } from "vitest";
import { publishableKeyIsWellFormed } from "./auth.js";

describe("publishableKeyIsWellFormed", () => {
  // "sample.instance.clerk.accounts.dev$" — the shape Clerk itself encodes.
  const validPayload = Buffer.from("sample.instance.clerk.accounts.dev$").toString("base64");

  it("accepts well-formed test and live keys", () => {
    expect(publishableKeyIsWellFormed(`pk_test_${validPayload}`)).toBe(true);
    expect(publishableKeyIsWellFormed(`pk_live_${validPayload}`)).toBe(true);
  });

  it("accepts base64url payload characters", () => {
    expect(publishableKeyIsWellFormed("pk_test_ab-c_d_e")).toBe(true);
  });

  it("rejects empty, prefix-less, and truncated keys", () => {
    expect(publishableKeyIsWellFormed("")).toBe(false);
    expect(publishableKeyIsWellFormed("pk_test_")).toBe(false);
    expect(publishableKeyIsWellFormed("sk_test_abc")).toBe(false);
    expect(publishableKeyIsWellFormed("not-a-key")).toBe(false);
  });

  it("rejects non-base64 payloads (Clerk would throw InvalidPublishableKeyError)", () => {
    expect(publishableKeyIsWellFormed("pk_test_!!!")).toBe(false);
  });
});
