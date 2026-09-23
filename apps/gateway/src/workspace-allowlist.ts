// Spec §10: "workspace allowlist — only curated repos mountable — no arbitrary
// host paths via chat." Default = empty allowlist = no workspaces accepted.
// Configure via GATEWAY_WORKSPACE_ALLOWLIST=/abs/path1,/abs/path2.

import { isAbsolute, resolve } from "node:path";

export interface WorkspaceAllowlist {
  /** Returns true if `workspace` is on the allowlist (or no allowlist configured). */
  isAllowed(workspace: string | null | undefined): boolean;
  /** Returns the absolute, normalized workspace path, or null if not allowed. */
  resolve(workspace: string | null | undefined): string | null;
  /** For diagnostics. */
  size(): number;
}

/** Reject any input that tries to escape the path with `..` or similar. */
function isSafePath(p: string): boolean {
  // No NULs (some kernels truncate at NUL). No embedded .. segments when
  // resolved. Absolute paths only.
  if (p.includes("\0")) return false;
  if (!isAbsolute(p)) return false;
  // resolve() normalizes; reject if it still contains .. segments.
  const normalized = resolve(p);
  return normalized === p || !normalized.includes("/../") && !normalized.endsWith("/..");
}

/**
 * Parse a comma-separated allowlist string. Returns the empty set for an
 * empty / unset env var — meaning NO workspaces are allowed. That's the
 * safe default: open it explicitly via env.
 */
export function parseAllowlist(envValue: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!envValue) return out;
  for (const raw of envValue.split(",")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (!isSafePath(trimmed)) continue; // skip unsafe entries, don't crash
    out.add(resolve(trimmed));
  }
  return out;
}

export function createWorkspaceAllowlist(envValue: string | undefined): WorkspaceAllowlist {
  const allowed = parseAllowlist(envValue);
  return {
    isAllowed(workspace) {
      if (workspace == null) return true; // null workspace is fine (platform-level chats)
      if (!isSafePath(workspace)) return false;
      if (allowed.size === 0) return false; // default-deny
      return allowed.has(resolve(workspace));
    },
    resolve(workspace) {
      if (workspace == null) return null;
      if (!isSafePath(workspace)) return null;
      if (!allowed.has(resolve(workspace))) return null;
      return resolve(workspace);
    },
    size() {
      return allowed.size;
    },
  };
}