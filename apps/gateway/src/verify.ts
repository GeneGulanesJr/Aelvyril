// #82: auto-verify loop. After an execution settles with edits, the gateway
// — not the user — runs tests/lint/typecheck in the workspace, feeds
// failures back to the agent with a bounded retry budget, and escalates to
// the user only with failure context attached. The exec surface is
// injectable so tests never shell out.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, access } from "node:fs/promises";
import { delimiter, extname, join } from "node:path";
import { computeChildEnv } from "./child-env.js";

export interface CommandResult {
  command: string;
  ok: boolean;
  /** Bounded output (stdout+stderr tail) for agent feedback. */
  output: string;
}

export type VerifyExec = (
  command: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<CommandResult>;

export interface VerifyOptions {
  cwd: string;
  commands: string[];
  timeoutMs?: number;
  exec?: VerifyExec;
  /** Max chars of combined output kept per command (agent feedback tail). */
  outputLimit?: number;
}

export interface VerificationRun {
  ok: boolean;
  results: CommandResult[];
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_OUTPUT_LIMIT = 8_000;

/**
 * win32 only: npm/pnpm/yarn ship as .cmd/.bat shims and execFile cannot
 * spawn those (Node refuses batch files without a shell since the 2024
 * argv-injection hardening — auto-verify failed on every Windows host).
 * An explicit .cmd/.bat suffix always counts; any other explicit extension
 * is a real executable; a bare name counts only when a `<name>.cmd` or
 * `<name>.bat` exists on PATH.
 */
function isCmdShim(file: string): boolean {
  const ext = extname(file).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") return true;
  if (ext !== "") return false;
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some(
      (dir) =>
        dir !== "" &&
        (existsSync(join(dir, `${file}.cmd`)) || existsSync(join(dir, `${file}.bat`))),
    );
}

/**
 * Resolve a verify command to execFile argv. win32 batch shims route
 * through `cmd /d /s /c` — the same quoting child_process uses for its own
 * shell:true path (the joined line rides as ONE quoted argument and /s
 * strips only the outer quotes). Everything else, and every POSIX command,
 * execs directly. `isShim` is injectable so the decision is unit-testable
 * cross-platform.
 */
export function resolveExecArgv(
  command: string[],
  platform: NodeJS.Platform = process.platform,
  isShim: (file: string) => boolean = isCmdShim,
): { file: string; args: string[] } {
  const [file = "", ...args] = command;
  if (platform === "win32" && isShim(file)) {
    return {
      file: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", command.join(" ")],
    };
  }
  return { file, args };
}

/** Default exec: split "pnpm run test" style strings and execFile them.
 *  The verify commands come from an agent-editable package.json, so the
 *  child gets the computeChildEnv boundary — never the gateway's full
 *  process.env (CLERK_ and GATEWAY_ secrets must not reach workspace
 *  scripts). */
export const defaultVerifyExec: VerifyExec = async (command, cwd, timeoutMs) => {
  const { file, args } = resolveExecArgv(command);
  const outputLimit = DEFAULT_OUTPUT_LIMIT;
  try {
    const res = await new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        file,
        args,
        { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: computeChildEnv({}) },
        (err, stdout, stderr) => {
          // A non-zero exit is a RESULT, not a rejection — verification
          // failures are the loop's working state. Only spawn-level errors
          // (ENOENT, EACCES) reject.
          if (err && typeof (err as { code?: unknown }).code !== "number") reject(err);
          else resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        },
      );
    });
    const combined = `${res.stdout}\n${res.stderr}`.trim();
    return { command: command.join(" "), ok: res.ok, output: combined.slice(-outputLimit) };
  } catch (err) {
    const e = err as { code?: unknown; killed?: boolean; stdout?: unknown; stderr?: unknown; message?: string };
    const combined = `${String(e.stdout ?? "")}\n${String(e.stderr ?? "")}\n${e.message ?? ""}`.trim();
    return { command: command.join(" "), ok: false, output: combined.slice(-outputLimit) };
  }
};

/**
 * Resolve the verify commands for a workspace. Explicit override wins
 * (GATEWAY_VERIFY_COMMANDS, comma-separated, e.g. "pnpm test,pnpm lint").
 * Otherwise: package.json scripts test/lint/typecheck that exist, run with
 * the detected package manager. No package.json → nothing to verify.
 */
export async function resolveVerifyCommands(
  cwd: string,
  override?: string,
): Promise<string[]> {
  if (override) {
    return override
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const pkgPath = join(cwd, "package.json");
  try {
    await access(pkgPath);
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
      packageManager?: string;
    };
    const scripts = pkg.scripts ?? {};
    const wanted = ["test", "lint", "typecheck"].filter((s) => typeof scripts[s] === "string");
    if (wanted.length === 0) return [];
    let runner = "npm run";
    try {
      await access(join(cwd, "pnpm-lock.yaml"));
      runner = "pnpm run";
    } catch {
      try {
        await access(join(cwd, "yarn.lock"));
        runner = "yarn";
      } catch {
        // npm fallback
      }
    }
    void pkg.packageManager;
    return wanted.map((s) => `${runner} ${s}`);
  } catch {
    return [];
  }
}

/** Flatten "pnpm run test" style strings into argv arrays (quote-aware —
 *  absolute tool paths on Windows routinely contain spaces). */
function toArgv(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const token = m[1] ?? m[2] ?? "";
    if (token) out.push(token);
  }
  return out;
}

/**
 * Run the verification commands in order; stop at the first failure.
 * Every result carries bounded output so the retry prompt can quote it.
 */
export async function runVerification(opts: VerifyOptions): Promise<VerificationRun> {
  const exec = opts.exec ?? defaultVerifyExec;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results: CommandResult[] = [];
  for (const command of opts.commands.map(toArgv)) {
    const res = await exec(command, opts.cwd, timeoutMs);
    results.push(res);
    if (!res.ok) return { ok: false, results };
  }
  return { ok: true, results };
}

/** Human/agent-facing summary of a failed run (bounded by result outputs). */
export function formatFailure(run: VerificationRun): string {
  return run.results
    .map((r) => `$ ${r.command}\n${r.output}`)
    .join("\n\n")
    .trim();
}
