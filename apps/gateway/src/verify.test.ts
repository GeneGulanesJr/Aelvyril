import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { formatFailure, resolveExecArgv, resolveVerifyCommands, runVerification } from "./verify.js";

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
      // The default exec resolves npm through cmd /c on win32 (npm is a
      // .cmd shim there) — covered by the win32-only exec test below.
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

describe("resolveExecArgv (win32 .cmd shims)", () => {
  // Injected predicate keeps the decision testable cross-platform: only
  // "pnpm" and explicit .cmd paths count as shims here.
  const isShim = (file: string) => file === "pnpm" || file.toLowerCase().endsWith(".cmd");

  it("passes POSIX commands straight through", () => {
    expect(resolveExecArgv(["pnpm", "run", "test"], "linux", isShim)).toEqual({
      file: "pnpm",
      args: ["run", "test"],
    });
  });

  it("routes batch shims through cmd /d /s /c on win32", () => {
    const { file, args } = resolveExecArgv(
      ["C:\\tools\\pnpm.cmd", "run", "test"],
      "win32",
      isShim,
    );
    // ComSpec may be an absolute path; only the basename matters.
    expect(basename(file).toLowerCase()).toBe("cmd.exe");
    expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    // The full line rides as one argument (child_process's own shell
    // quoting shape), so cmd strips exactly the outer quotes.
    expect(args[3]).toBe("C:\\tools\\pnpm.cmd run test");
  });

  it("win32 leaves real executables alone", () => {
    const { file, args } = resolveExecArgv(
      [process.execPath, "-e", "process.exit(0)"],
      "win32",
      isShim,
    );
    expect(file).toBe(process.execPath);
    expect(args).toEqual(["-e", "process.exit(0)"]);
  });
});

describe("defaultVerifyExec child environment", () => {
  it("hands the child the allowlisted env — operator secrets never reach verify scripts", async () => {
    const dir = tmpWorkspace();
    const prev = process.env.CLERK_SECRET_KEY;
    process.env.CLERK_SECRET_KEY = "sk_test_must_not_leak";
    try {
      const run = await runVerification({
        cwd: dir,
        commands: [
          `"${process.execPath}" -e "const leaks = Object.keys(process.env).filter((k) => /^(CLERK_|GATEWAY_)/.test(k)); console.log(JSON.stringify({ leaks, hasPath: Boolean(process.env.PATH) }));"`,
        ],
      });
      expect(run.ok).toBe(true);
      // PATH passes (the runner must be resolvable); CLERK_* never does.
      expect(JSON.parse(run.results[0]!.output)).toEqual({ leaks: [], hasPath: true });
    } finally {
      if (prev === undefined) delete process.env.CLERK_SECRET_KEY;
      else process.env.CLERK_SECRET_KEY = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const win32Only = process.platform === "win32" ? it : it.skip;
  win32Only(
    "win32: a .cmd batch file runs via cmd /c, so package-manager shims verify",
    async () => {
      const dir = tmpWorkspace();
      writeFileSync(join(dir, "echo-ok.cmd"), "@echo ok-from-cmd\r\n");
      try {
        const run = await runVerification({
          cwd: dir,
          commands: [`"${join(dir, "echo-ok.cmd")}"`],
        });
        expect(run.ok).toBe(true);
        expect(run.results[0]!.output).toContain("ok-from-cmd");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

function mkdirSyncSafe(): string {
  const dir = mkdtempSync(join(tmpdir(), "aelvyril-verify-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}
