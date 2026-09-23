// Manual update flow: the gateway can check for upstream git changes and
// apply them in-place. Designed for the dev / self-hosted case — in
// production, Docker's restart policy handles container lifecycle.
//
// Security note (v1): any signed-in user can trigger an update. There's
// no admin-role gate yet. For a multi-tenant SaaS, this needs Clerk
// Organizations + a `admin` role on the user. The endpoint lives under
// `/v1/admin/` to make the privilege boundary explicit when that lands.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileP = promisify(execFile);

export interface UpdateStatus {
  currentSha: string;
  currentShort: string;
  remoteSha: string;
  remoteShort: string;
  /** 0 = up-to-date, >0 = N commits behind. */
  behind: number;
  /** ISO timestamp of the last successful fetch. */
  fetchedAt: string;
  /** Absolute path to the repo root the gateway was started from. */
  repoPath: string;
}

/**
 * Resolve the repo root. We use `cwd()` at module init so the gateway
 * must be started from inside the Aelvyril repo (true in dev + Docker).
 */
function repoRoot(): string {
  return resolve(process.cwd());
}

async function git(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return execFileP("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
}

/**
 * Read the current local HEAD sha.
 */
async function readLocalHead(repoPath: string): Promise<string> {
  const { stdout } = await git(["rev-parse", "HEAD"], repoPath);
  return stdout.trim();
}

/**
 * `git fetch origin` (best-effort) + read origin/main HEAD.
 * Throws on network error / missing remote — caller surfaces.
 */
async function readRemoteHead(repoPath: string, ref = "origin/main"): Promise<string> {
  try {
    await git(["fetch", "origin"], repoPath);
  } catch {
    // Network down or no remote configured — caller decides.
    throw new Error(`git fetch failed — check network / remote config`);
  }
  const { stdout } = await git(["rev-parse", ref], repoPath);
  return stdout.trim();
}

/**
 * `git rev-list --count HEAD..origin/main` — number of commits the local
 * branch is behind origin/main. 0 = up-to-date.
 */
async function commitsBehind(repoPath: string): Promise<number> {
  const { stdout } = await git(
    ["rev-list", "--count", "HEAD..origin/main"],
    repoPath,
  );
  return Number(stdout.trim()) || 0;
}

/**
 * Fetch status: reads the local + remote HEADs and counts how far behind.
 */
export async function getUpdateStatus(): Promise<UpdateStatus> {
  const repoPath = repoRoot();
  const currentSha = await readLocalHead(repoPath);
  const remoteSha = await readRemoteHead(repoPath);
  const behind = await commitsBehind(repoPath);
  return {
    currentSha,
    currentShort: currentSha.slice(0, 7),
    remoteSha,
    remoteShort: remoteSha.slice(0, 7),
    behind,
    fetchedAt: new Date().toISOString(),
    repoPath,
  };
}

export interface ApplyResult {
  started: boolean;
  message: string;
}

/**
 * Apply the update. Spawns a detached subprocess that runs
 * `git pull` → `pnpm install` → restarts the gateway. The current
 * request responds immediately; the subprocess kills us with SIGTERM
 * after a short grace period so Docker's `restart: unless-stopped`
 * (or the operator's process manager in dev) picks up the new code.
 *
 * Returns {started: true, ...} on success, or throws with stderr.
 */
export async function applyUpdate(): Promise<ApplyResult> {
  const repoPath = repoRoot();
  // Fail fast if the working tree is dirty — refuse to clobber local
  // changes during an update.
  const { stdout: status } = await git(["status", "--porcelain"], repoPath);
  if (status.trim().length > 0) {
    throw new Error(
      "working tree is dirty — commit or stash local changes before updating",
    );
  }
  // Spawn detached so this function can return without waiting. The
  // subprocess does the heavy lifting and restarts us.
  const script = `
    set -e
    cd "${repoPath}"
    echo "[updater] $(date -Iseconds) git pull"
    git pull --ff-only
    echo "[updater] $(date -Iseconds) pnpm install"
    pnpm install --frozen-lockfile --prefer-offline 2>&1 | tail -20
    echo "[updater] $(date -Iseconds) restart"
    # Give the route a moment to respond + the client to receive.
    sleep 2
    # Find + SIGTERM the current gateway process. Self PID via $$,
    # but $$ in a subshell is the subshell PID — use the parent's PPID
    # captured at script start instead.
    kill -TERM $PPID
  `;
  const child = spawn("bash", ["-c", script], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, PATH: process.env.PATH ?? "/usr/bin:/usr/local/bin" },
  });
  child.unref();
  return {
    started: true,
    message:
      "Update queued. The gateway will restart in ~3s — the page will reconnect automatically.",
  };
}
