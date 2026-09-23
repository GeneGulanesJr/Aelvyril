import { describe, expect, it } from "vitest";
import { createWorkspaceAllowlist, parseAllowlist } from "./workspace-allowlist.js";

describe("createWorkspaceAllowlist", () => {
  it("default-deny: empty env rejects all workspaces", () => {
    const wl = createWorkspaceAllowlist(undefined);
    expect(wl.isAllowed("/any/path")).toBe(false);
    expect(wl.isAllowed(null)).toBe(true);
    expect(wl.size()).toBe(0);
  });

  it("accepts allowlisted absolute paths", () => {
    const wl = createWorkspaceAllowlist("/home/repo1,/home/repo2");
    expect(wl.isAllowed("/home/repo1")).toBe(true);
    expect(wl.isAllowed("/home/repo2")).toBe(true);
    expect(wl.isAllowed("/home/repo3")).toBe(false);
  });

  it("rejects relative paths and traversal attempts", () => {
    const wl = createWorkspaceAllowlist("/home/repo1");
    expect(wl.isAllowed("relative/path")).toBe(false);
    expect(wl.isAllowed("/home/repo1/../etc/passwd")).toBe(false);
    expect(wl.isAllowed("/home/repo1/../../escape")).toBe(false);
  });

  it("skips unsafe entries from the env var (no crash, no include)", () => {
    const wl = createWorkspaceAllowlist("/safe,relative/not,/also/safe");
    expect(wl.isAllowed("/safe")).toBe(true);
    expect(wl.isAllowed("/also/safe")).toBe(true);
    expect(wl.isAllowed("relative/not")).toBe(false);
    expect(wl.size()).toBe(2);
  });

  it("resolve returns the absolute path or null", () => {
    const wl = createWorkspaceAllowlist("/home/repo1");
    expect(wl.resolve("/home/repo1")).toBe("/home/repo1");
    expect(wl.resolve("/home/repo2")).toBeNull();
    expect(wl.resolve(null)).toBeNull();
  });

  it("parseAllowlist trims whitespace and ignores empties", () => {
    const set = parseAllowlist(" /a ,, /b , ");
    expect(set.size).toBe(2);
    expect(set.has("/a")).toBe(true);
    expect(set.has("/b")).toBe(true);
  });
});