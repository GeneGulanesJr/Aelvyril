// Tests use a real temp git repo so we exercise the actual execFile + git
// subprocess. Cheap (~50ms each) and avoids brittle mock choreography.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFile as execFileCb, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFile = promisify(execFileCb);

const realCwd = process.cwd;
let tmpDir = "";

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "aelvyril-updater-"));
  await execFile("git", ["init", "-b", "main", tmpDir]);
  await execFile("git", ["-C", tmpDir, "config", "user.email", "test@example.com"]);
  await execFile("git", ["-C", tmpDir, "config", "user.name", "Test"]);
  writeFileSync(join(tmpDir, "README.md"), "hello\n");
  await execFile("git", ["-C", tmpDir, "add", "."]);
  await execFile("git", ["-C", tmpDir, "commit", "-m", "init"]);
  process.cwd = () => tmpDir;
});

afterEach(() => {
  process.cwd = realCwd;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe("getUpdateStatus", () => {
  it("throws when no remote is configured (operator hasn't set one up yet)", async () => {
    const { getUpdateStatus } = await import("./updater.js");
    await expect(getUpdateStatus()).rejects.toThrow(/git fetch failed/);
  });

  it("reports zero commits behind when local HEAD matches remote HEAD", async () => {
    // Add a fake "origin" pointing at the same repo so `git fetch` succeeds
    // and `origin/main` resolves to the same commit.
    await execFile("git", ["-C", tmpDir, "remote", "add", "origin", tmpDir]);
    const { getUpdateStatus } = await import("./updater.js");
    const status = await getUpdateStatus();
    expect(status.behind).toBe(0);
    expect(status.currentShort).toHaveLength(7);
    expect(status.remoteShort).toHaveLength(7);
    expect(status.currentShort).toBe(status.remoteShort);
    expect(status.repoPath).toBe(tmpDir);
  });
});

describe("applyUpdate", () => {
  it("refuses to run when the working tree is dirty", async () => {
    const { applyUpdate } = await import("./updater.js");
    writeFileSync(join(tmpDir, "uncommitted.txt"), "dirty");
    await expect(applyUpdate()).rejects.toThrow(/working tree is dirty/);
  });

  // Review: a failed spawn (no bash on this host) used to emit an unobserved
  // child 'error' — a fatal uncaught exception that took the gateway down
  // instead of the admin route's update_failed reply.
  it("reports a failed spawn as a structured update failure, not a crash", async () => {
    const { applyUpdate } = await import("./updater.js");
    await expect(
      applyUpdate({ shell: "definitely-not-a-real-shell-xyz" }),
    ).rejects.toThrow(/failed to start/);
  });
});

// Review 2026-10-15: `pnpm install --frozen-lockfile --prefer-offline
// 2>&1 | tail -20` was the last command in the script. With only
// `set -e` (no pipefail), the pipeline returned `tail`'s exit code (0)
// even when pnpm install failed — the gateway SIGTERM'd itself and
// restarted on stale deps. `set -eo pipefail` is the fix; this test
// runs the same shape of script under bash with a guaranteed-to-fail
// command piped to a guaranteed-to-succeed tail and asserts non-zero.
describe("buildUpdateScript pipefail (review 2026-10-15)", () => {
  const bashAvailable = (() => {
      try {
        execFileSync("bash", ["-c", "true"], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })();

  it("the script enables pipefail (set -eo pipefail)", async () => {
    const { buildUpdateScript } = await import("./updater.js");
    const script = buildUpdateScript("/tmp/repo");
    expect(script).toContain("set -eo pipefail");
    expect(script).toContain("pipefail");
  });

  const itBash = bashAvailable ? it : it.skip;
  itBash(
    "a pipeline with a failing left side and a succeeding right side exits non-zero (pipefail works)",
    async () => {
      // Standalone proxy that mirrors the script's exact failure mode:
      // a command that exits non-zero piped into `tail`. With pipefail
      // the script must exit non-zero, with just `set -e` it exits 0.
      // execFile rejects on non-zero exit; we assert the rejection
      // AND that the post-pipeline `echo` was never reached.
      let stdout = "";
      let exitCode: number | null = null;
      try {
        const res = await execFile("bash", [
          "-c",
          "set -eo pipefail; (exit 7) | tail -1; echo SHOULD_NOT_REACH",
        ]);
        stdout = res.stdout;
      } catch (err) {
        const e = err as { stdout?: string; code?: unknown };
        stdout = e.stdout ?? "";
        exitCode = typeof e.code === "number" ? e.code : null;
      }
      expect(exitCode).not.toBe(0);
      expect(stdout).not.toContain("SHOULD_NOT_REACH");
    },
  );
});
