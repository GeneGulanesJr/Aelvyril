import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeWorkspaceDiff } from "./workspace-git.js";

function git(dir: string, args: string[]): void {
  execFileSync("git", ["-C", dir, "-c", "user.email=a@b.c", "-c", "user.name=t", ...args], {
    stdio: "ignore",
  });
}

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aelvyril-git-"));
  git(dir, ["init"]);
  writeFileSync(join(dir, "base.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

describe("computeWorkspaceDiff (#80)", () => {
  it("returns null for a directory that is not a git work tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aelvyril-nogit-"));
    try {
      expect(await computeWorkspaceDiff(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] for a clean tree", async () => {
    const dir = tmpRepo();
    try {
      expect(await computeWorkspaceDiff(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("splits tracked edits into per-file patches", async () => {
    const dir = tmpRepo();
    try {
      writeFileSync(join(dir, "base.txt"), "changed\n");
      const diff = (await computeWorkspaceDiff(dir))!;
      expect(diff).toHaveLength(1);
      expect(diff[0]!.path).toBe("base.txt");
      expect(diff[0]!.patch).toContain("diff --git a/base.txt b/base.txt");
      expect(diff[0]!.patch).toContain("+changed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes untracked files as new-file patches", async () => {
    const dir = tmpRepo();
    try {
      writeFileSync(join(dir, "new.ts"), "export {};\n");
      const diff = (await computeWorkspaceDiff(dir))!;
      expect(diff.map((f) => f.path)).toContain("new.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
