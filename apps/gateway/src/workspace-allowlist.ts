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

/** Reject any input that tries to escape the path with `..` or similar.
 *  Review 2026-10-15: tightened from `!includes("/../")` to canonical
 *  equality. The kernel resolves `..` *physically* when used as a child's
 *  cwd, so a path like `/allowed/symlink/..` lexically resolves to
 *  `/allowed`, passes the old `!includes` check, then lands the cwd
 *  outside the allowlisted directory. Requiring `resolve(p) === p` (with
 *  the NUL + absolute guards) is the only exact-match-safe basis. */
function isSafePath(p: string): boolean {
  // No NULs (some kernels truncate at NUL). Absolute paths only.
  if (p.includes("\0")) return false;
  if (!isAbsolute(p)) return false;
  // Canonical input: rejects `..`, `.`, duplicate and trailing slashes,
  // and any other normalization that the kernel would NOT then apply.
  return resolve(p) === p;
}

/**
 * Parse a comma-separated allowlist string. Returns the empty set for an
 * empty / unset env var — meaning NO workspaces are allowed. That's the
 * safe default: open it explicitly via env.
 *
 * Allowlist entries are operator-controlled config (not chat input), so
 * we normalize trailing slashes etc. rather than reject them — the same
 * `parseAllowlist("/ws/repo")` and `parseAllowlist("/ws/repo/")` should
 * produce the same set entry.
 */
export function parseAllowlist(envValue: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!envValue) return out;
  for (const raw of envValue.split(",")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.includes("\0")) continue;
    if (!isAbsolute(trimmed)) continue;
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