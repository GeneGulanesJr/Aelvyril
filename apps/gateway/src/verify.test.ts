import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatFailure, resolveVerifyCommands, runVerification } from "./verify.js";

function tmpWorkspace(withPkg?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "aelvyril-verify-"));
  if (withPkg) writeFileSync(join(dir, "package.json"), JSON.stringify(withPkg));
  return dir;
}

describe("resolveVerifyCommands (#82)", () => {
  it("override wins and splits on commas", async () => {
    const dir = tmpWorkspace();
    try {
      expect(await resolveVerifyCommands(dir, "pnpm test, pnpm lint")).toEqual([
        "pnpm test",
        "pnpm lint",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-detects test/lint/typecheck scripts with the pnpm runner", async () => {
    const dir = tmpWorkspace({
      scripts: { test: "vitest", lint: "eslint .", typecheck: "tsc --noEmit", build: "tsc" },
    });
    try {
      writeFileSync(join(dir, "pnpm-lock.yaml"), "");
      expect(await resolveVerifyCommands(dir)).toEqual([
        "pnpm run test",
        "pnpm run lint",
        "pnpm run typecheck",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("only picks scripts that exist", async () => {
    const dir = tmpWorkspace({ scripts: { test: "vitest" } });
    try {
      expect(await resolveVerifyCommands(dir)).toEqual(["npm run test"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns nothing without a package.json", async () => {
    const dir = tmpWorkspace();
    try {
      expect(await resolveVerifyCommands(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runVerification (#82)", () => {
  it("runs commands in order and stops at the first failure", async () => {
    const ran: string[] = [];
    const exec = async (command: string[]) => {
      ran.push(command.join(" "));
      if (command.join(" ") === "fail") {
        return { command: command.join(" "), ok: false, output: "ERR line" };
      }
      return { command: command.join(" "), ok: true, output: "ok" };
    };
    const run = await runVerification({
      cwd: "/anywhere",
      commands: ["pass one", "fail", "never reached"],
      exec,
    });
    expect(ran).toEqual(["pass one", "fail"]);
    expect(run.ok).toBe(false);
    expect(formatFailure(run)).toContain("$ fail");
    expect(formatFailure(run)).toContain("ERR line");
  });

  it("a clean run is ok with all results", async () => {
    const run = await runVerification({
      cwd: "/anywhere",
      commands: ["a", "b"],
      exec: async (command) => ({ command: command.join(" "), ok: true, output: "" }),
    });
    expect(run.ok).toBe(true);
    expect(run.results).toHaveLength(2);
  });

  it("the default exec shells out and reports non-zero exits as results", async () => {
    const dir = tmpWorkspace();
    try {
      const node = process.execPath;
      const ok = await runVerification({
        cwd: dir,
        commands: [`"${node}" -e "process.exit(0)"`],
      });
      const bad = await runVerification({
        cwd: dir,
        commands: [`"${node}" -e "console.error('boom'); process.exit(3)"`],
      });
      expect(ok.ok).toBe(true);
      expect(bad.ok).toBe(false);
      expect(bad.results[0]!.output).toContain("boom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves commands against a real package.json layout", async () => {
    const dir = tmpWorkspace({ scripts: { test: "node -e \"process.exit(0)\"" } });
    try {
      const commands = await resolveVerifyCommands(dir);
      expect(commands).toEqual(["npm run test"]);
      // The run path is covered by the default-exec test below with a
      // direct executable — npm is a .cmd shim on Windows and execFile
      // cannot spawn it without a shell.
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missing binaries surface as failed results, not throws", async () => {
    const dir = mkdirSyncSafe();
    try {
      const run = await runVerification({
        cwd: dir,
        commands: ["definitely-not-a-real-binary-xyz --version"],
      });
      expect(run.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function mkdirSyncSafe(): string {
  const dir = mkdtempSync(join(tmpdir(), "aelvyril-verify-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}
