import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeWorkspaceDiff, MAX_PATCH_CHARS, type GitExec } from "./workspace-git.js";

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

  // Dogfood 2026-10-09: a name-only stub gave the reviewer "+0 -0 (content
  // not inlined)" for exactly the new files a human most needs to read.
  it("inlines untracked file content as a real new-file patch", async () => {
    const dir = tmpRepo();
    try {
      writeFileSync(join(dir, "greet.js"), "export function greet(name) {\n  return `Hello, ${name}!`;\n}\n");
      const diff = (await computeWorkspaceDiff(dir))!;
      const patch = diff.find((f) => f.path === "greet.js")!.patch;
      expect(patch).toContain("new file mode");
      expect(patch).toContain("--- /dev/null");
      expect(patch).toContain("+++ b/greet.js");
      expect(patch).toContain("+export function greet(name)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds oversized untracked patches with a truncation marker", async () => {
    const dir = tmpRepo();
    try {
      writeFileSync(join(dir, "big.txt"), "x".repeat(MAX_PATCH_CHARS + 5_000) + "\n");
      const diff = (await computeWorkspaceDiff(dir))!;
      const patch = diff.find((f) => f.path === "big.txt")!.patch;
      expect(patch.length).toBeLessThan(MAX_PATCH_CHARS + 200);
      expect(patch).toContain("(truncated at");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Review 2026-10-15: defaultGitExec must (a) neutralize repo-config command
// execution on every invocation so an agent that writes .git/config can't
// make the gateway execute an attacker binary via diff.external / fsmonitor
// / textconv; and (b) hand the child the computeChildEnv boundary so
// CLERK_* / GATEWAY_* secrets never reach a workspace git subprocess.
describe("defaultGitExec hardening (review 2026-10-15)", () => {
  // (a) injected exec captures every argv we hand to git and asserts the
  // repo-config-neutralizing flags are present on every invocation —
  // including the probe and ls-files calls, not just the diffs.
  it("prefixes every git invocation with -c core.fsmonitor=false and -c diff.external=", async () => {
    const calls: string[][] = [];
    const exec: GitExec = (args, _cwd) => {
      calls.push(args);
      // arg shape is [..REPO_NEUTRAL_FLAGS, ...realArgs], so look at the
      // tail of the array to identify the call.
      const tail = args.slice(-2);
      if (tail[0] === "rev-parse") return Promise.resolve({ ok: true, stdout: "true" });
      if (args.includes("diff") && args.includes("HEAD")) {
        return Promise.resolve({ ok: true, stdout: "" });
      }
      if (tail[0] === "ls-files") return Promise.resolve({ ok: true, stdout: "" });
      return Promise.resolve({ ok: true, stdout: "" });
    };
    await computeWorkspaceDiff("/anywhere", exec);
    expect(calls.length).toBeGreaterThanOrEqual(3); // probe + diff HEAD + ls-files + (per-file diff)
    for (const argv of calls) {
      expect(argv).toContain("core.fsmonitor=false");
      expect(argv).toContain("diff.external=");
    }
  });

  it("appends --no-ext-diff --no-textconv only to diff invocations", async () => {
    const calls: string[][] = [];
    const exec: GitExec = (args, _cwd) => {
      calls.push(args);
      if (args.includes("rev-parse")) return Promise.resolve({ ok: true, stdout: "true" });
      if (args.includes("ls-files")) return Promise.resolve({ ok: true, stdout: "new.txt\n" });
      if (args.includes("diff")) return Promise.resolve({ ok: true, stdout: "diff content" });
      return Promise.resolve({ ok: true, stdout: "" });
    };
    await computeWorkspaceDiff("/anywhere", exec);
    const diffs = calls.filter((a) => a.includes("diff"));
    expect(diffs.length).toBeGreaterThanOrEqual(2); // diff HEAD + diff --no-index
    for (const d of diffs) {
      expect(d).toContain("--no-ext-diff");
      expect(d).toContain("--no-textconv");
    }
    const nonDiffs = calls.filter((a) => !a.includes("diff"));
    for (const nd of nonDiffs) {
      expect(nd).not.toContain("--no-ext-diff");
      expect(nd).not.toContain("--no-textconv");
    }
  });

  // (b) real-git integration: drop a hostile `diff.external` command into
  // the temp repo's .git/config that would create a marker file if git
  // honored it. The fix must produce the marker-less, normal diff.
  const gitAvailable = (() => {
      try {
        execFileSync("git", ["--version"], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })();

  const itRealGit = gitAvailable ? it : it.skip;
  itRealGit(
    "neutralizes repo-local diff.external so an attacker .git/config cannot run an arbitrary binary",
    async () => {
      const dir = tmpRepo();
      const marker = join(dir, "diff-external-was-here.marker");
      try {
        // Make a tracked edit so `diff HEAD` actually invokes the external.
        writeFileSync(join(dir, "base.txt"), "changed\n");
        // Hostile config: if honored, this would `touch` the marker before
        // git produces its unified diff.
        git(dir, ["config", "diff.external", `touch ${marker}`]);
        writeFileSync(join(dir, ".gitattributes"), "*.txt diff=evil\n");
        git(dir, ["config", "diff.evil.textconv", `touch ${marker}.textconv;`]);

        const diff = await computeWorkspaceDiff(dir);
        expect(diff).not.toBeNull();
        expect(diff!.length).toBeGreaterThan(0);
        expect(diff![0]!.patch).toContain("+changed");

        expect(existsSync(marker)).toBe(false);
        expect(existsSync(`${marker}.textconv`)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  // (c) the default exec must hand git the computeChildEnv boundary, not
  // process.env. The cleanest assertion is via vi.mock: intercept the
  // real `execFile` and capture the env it gets handed. ESM modules
  // can't be spied on, but vi.mock replaces the module wholesale.
  it("defaultGitExec hands execFile the computeChildEnv boundary — operator secrets never reach the child", async () => {
    vi.resetModules();
    const prevClerk = process.env.CLERK_SECRET_KEY;
    const prevGateway = process.env.GATEWAY_TEST_LEAK;
    process.env.CLERK_SECRET_KEY = "sk_test_must_not_leak";
    process.env.GATEWAY_TEST_LEAK = "must-not-leak";
    const calls: Array<{ args: unknown[]; opts: { env?: Record<string, string> } }> = [];
    vi.doMock("node:child_process", () => ({
      execFile: (
        file: string,
        args: string[],
        opts: { env?: Record<string, string> },
        cb: (err: unknown, stdout: string) => void,
      ) => {
        calls.push({ args: [file, ...args], opts });
        cb(null, "");
      },
    }));
    try {
      const { defaultGitExec: mockedExec } = await import("./workspace-git.js");
      await mockedExec(["rev-parse", "HEAD"], "/anywhere");
      expect(calls.length).toBe(1);
      const env = calls[0]!.opts.env!;
      expect(env["CLERK_SECRET_KEY"]).toBeUndefined();
      expect(env["GATEWAY_TEST_LEAK"]).toBeUndefined();
      expect(env["PATH"]).toBeDefined();
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
      if (prevClerk === undefined) delete process.env.CLERK_SECRET_KEY;
      else process.env.CLERK_SECRET_KEY = prevClerk;
      if (prevGateway === undefined) delete process.env.GATEWAY_TEST_LEAK;
      else process.env.GATEWAY_TEST_LEAK = prevGateway;
    }
  });
});
