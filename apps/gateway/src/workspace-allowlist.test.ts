import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
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
    // parseAllowlist stores resolve()'d paths — compare against resolve() so
    // the expectation holds on POSIX and Windows alike.
    expect(wl.resolve("/home/repo1")).toBe(resolve("/home/repo1"));
    expect(wl.resolve("/home/repo2")).toBeNull();
    expect(wl.resolve(null)).toBeNull();
  });

  it("parseAllowlist trims whitespace and ignores empties", () => {
    const set = parseAllowlist(" /a ,, /b , ");
    expect(set.size).toBe(2);
    expect(set.has(resolve("/a"))).toBe(true);
    expect(set.has(resolve("/b"))).toBe(true);
  });

  // Review 2026-10-15: canonical-input check (resolve(p) === p) — the
  // old "!includes('/../')" check passed `<allowed>/<symlink>/..` because
  // resolve() collapses `..` lexically, but the kernel then resolves it
  // physically when used as a child cwd, landing outside the allowlist.
  describe("canonical-path hardening (review 2026-10-15)", () => {
    it("accepts a canonical allowlisted path", () => {
      const wl = createWorkspaceAllowlist("/ws/repo");
      expect(wl.isAllowed("/ws/repo")).toBe(true);
      expect(wl.resolve("/ws/repo")).toBe(resolve("/ws/repo"));
    });

    it("rejects traversal segments (the symlink-.. escape)", () => {
      const wl = createWorkspaceAllowlist("/ws/repo");
      expect(wl.isAllowed("/ws/repo/link/..")).toBe(false);
      expect(wl.resolve("/ws/repo/link/..")).toBeNull();
    });

    it("rejects `./` and `//` segments (resolve-normalizable input)", () => {
      const wl = createWorkspaceAllowlist("/ws/repo");
      expect(wl.isAllowed("/ws/repo/./")).toBe(false);
      expect(wl.isAllowed("/ws//repo")).toBe(false);
    });

    it("rejects a trailing slash on the workspace (canonical mismatch)", () => {
      const wl = createWorkspaceAllowlist("/ws/repo");
      // resolve("/ws/repo/") === "/ws/repo", so the trailing slash makes
      // the input non-canonical and is rejected — the caller is asked to
      // pass the same form the operator configured.
      expect(wl.isAllowed("/ws/repo/")).toBe(false);
      expect(wl.resolve("/ws/repo/")).toBeNull();
    });

    it("rejects relative paths and NUL bytes", () => {
      const wl = createWorkspaceAllowlist("/ws/repo");
      expect(wl.isAllowed("relative/path")).toBe(false);
      expect(wl.isAllowed("\0/escape")).toBe(false);
    });

    it("null/undefined workspaces stay allowed (platform-level chats)", () => {
      const wl = createWorkspaceAllowlist("/ws/repo");
      expect(wl.isAllowed(null)).toBe(true);
      expect(wl.isAllowed(undefined)).toBe(true);
    });

    it("parseAllowlist still normalizes trailing slashes on operator config", () => {
      // Operator-supplied allowlist entries are config, not chat input —
      // /ws/repo and /ws/repo/ must produce the same canonical entry.
      const a = parseAllowlist("/ws/repo");
      const b = parseAllowlist("/ws/repo/");
      expect(a.has(resolve("/ws/repo"))).toBe(true);
      expect(b.has(resolve("/ws/repo"))).toBe(true);
    });
  });
});