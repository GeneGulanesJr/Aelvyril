// Tests use a real temp git repo so we exercise the actual execFile + git
// subprocess. Cheap (~50ms each) and avoids brittle mock choreography.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFile as execFileCb } from "node:child_process";
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
});
