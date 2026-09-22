import { describe, expect, it } from "vitest";
import { SHARED_NAMESPACE, toUserNamespace } from "./namespace.js";

describe("toUserNamespace", () => {
  it("prefixes a clerk user id", () => {
    expect(toUserNamespace("user_2AbC123")).toBe("user:user_2abc123");
  });

  it("lowercases (LaPis lowercases project keys)", () => {
    expect(toUserNamespace("USER_XYZ")).toBe("user:user_xyz");
  });

  it("rejects empty ids", () => {
    expect(() => toUserNamespace("")).toThrow();
  });
});

describe("SHARED_NAMESPACE", () => {
  it("is the platform scope", () => {
    expect(SHARED_NAMESPACE).toBe("platform");
  });
});
