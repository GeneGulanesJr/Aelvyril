import { describe, expect, it } from "vitest";
import { shouldEnterSpecMode } from "./spec-heuristic.js";

describe("shouldEnterSpecMode", () => {
  it("off mode never triggers", () => {
    expect(shouldEnterSpecMode("rename x to y", "off")).toBe(false);
  });
  it("force mode always triggers", () => {
    expect(shouldEnterSpecMode("rename x to y", "force")).toBe(true);
  });
  it("auto: short single-file rename does not trigger", () => {
    expect(shouldEnterSpecMode("rename getUserById to findUserById", "auto")).toBe(false);
  });
  it("auto: multi-feature ask triggers", () => {
    expect(shouldEnterSpecMode("add role-based access to admin dashboard", "auto")).toBe(true);
  });
  it("auto: long single sentence triggers", () => {
    const prompt = "build a complete authentication system with login, logout, password reset, email verification, OAuth integration, and admin role management that supports multiple tenants";
    expect(shouldEnterSpecMode(prompt, "auto")).toBe(true);
  });
  it("auto: 2+ imperative verbs trigger", () => {
    expect(shouldEnterSpecMode("add a button and integrate the payment flow", "auto")).toBe(true);
  });
});
