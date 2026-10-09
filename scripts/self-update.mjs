#!/usr/bin/env node
// Self-update keeper for Aelvyril host-process deployments (the dev /
// self-hosted case — the machine runs web + gateway as bare node processes,
// no Docker). Loop mode checks origin/main on an interval and, when there is
// new code: verifies the stack is healthy FIRST, applies the update, restarts
// only the services the diff touched, verifies health again, and — when the
// fresh code fails verification — resets the tree back to the last
// known-good commit and restores it. A consecutive-failure breaker stops the
// loop after repeated bad updates until an operator clears it.
//
// Why a separate process: the in-gateway admin updater
// (apps/gateway/src/updater.ts) can apply an update, but it ends by killing
// the gateway — on a bare host nothing brings it back, and a dead gateway
// cannot roll itself back. This keeper outlives every restart, so rollback
// always has a live brain.
//
// Usage:
//   node scripts/self-update.mjs            # one check/apply cycle (default)
//   node scripts/self-update.mjs --loop     # keep running, check on interval
//   node scripts/self-update.mjs --status   # print state, no side effects
//   node scripts/self-update.mjs --restart  # bounce web+gateway now, verify
//   node scripts/self-update.mjs --rollback [sha]  # restore a commit manually
//   node scripts/self-update.mjs --reset    # clear failure count + breaker
//
// Exit codes (once mode): 0 ok / up-to-date · 2 skipped (unhealthy stack,
// dirty tree, CI not green) · 3 restart verification failed · 4 update
// applied then rolled back · 5 rollback failed (breaker tripped) ·
// 6 breaker disabled · 7 another keeper holds the lock.

import { spawn, execFile } from "node:child_process";
import {
  existsSync,
  renameSync,
  statSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Configuration (env-overridable; defaults match this repo's dev deployment)
// ---------------------------------------------------------------------------

const envFlag = (name, dflt = false) => {
  const v = process.env[name];
  return v === undefined || v === "" ? dflt : v !== "0" && v !== "false";
};
const envInt = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};
const envList = (name, dflt) => {
  const v = process.env[name];
  return v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : dflt;
};

const CONFIG = {
  intervalS: envInt("SELF_UPDATE_INTERVAL_S", 300),
  stateDir: resolve(ROOT, process.env.SELF_UPDATE_STATE_DIR ?? ".self-update"),
  healthTimeoutS: envInt("SELF_UPDATE_HEALTH_TIMEOUT_S", 120),
  maxFailures: envInt("SELF_UPDATE_MAX_FAILURES", 3),
  // Generated files that are always dirty locally (next dev rewrites this
  // one on every build) — auto-restored before merging instead of blocking.
  allowlist: envList("SELF_UPDATE_ALLOWLIST", ["apps/web/next-env.d.ts"]),
  // A URL is alive when it answers with status < 500, OR — gateway /healthz
  // returns 503 when an OPTIONAL backing probe fails (layamcp cold) — when
  // the body says gateway.ok. Without the body rule every layamcp cold
  // start would look like a bad deploy and trigger pointless rollbacks.
  healthUrls: envList("SELF_UPDATE_HEALTH_URLS", [
    "http://127.0.0.1:8787/healthz",
    "http://127.0.0.1:3000/",
  ]),
  gatewayPort: envInt("SELF_UPDATE_GATEWAY_PORT", 8787),
  webPort: envInt("SELF_UPDATE_WEB_PORT", 3000),
  requireCi: envFlag("SELF_UPDATE_REQUIRE_CI", false),
  // Only needed when web runs `next start` (prod) — dev recompiles itself.
  webBuild: envFlag("SELF_UPDATE_WEB_BUILD", false),
  // Full replacement command strings (run via shell). Defaults launch the
  // exact commands this deployment runs today.
  gatewayCmd: process.env.SELF_UPDATE_GATEWAY_CMD,
  webCmd: process.env.SELF_UPDATE_WEB_CMD,
};

const STATE_FILE = () => resolve(CONFIG.stateDir, "state.json");
const HISTORY_FILE = () => resolve(CONFIG.stateDir, "history.log");
const LOCK_FILE = () => resolve(CONFIG.stateDir, "lock");
const DISABLED_FILE = () => resolve(CONFIG.stateDir, "disabled");

// ---------------------------------------------------------------------------
// Logging — console plus keeper.log so Task Scheduler runs leave a trail
// ---------------------------------------------------------------------------

let keeperLog = null;
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  if (keeperLog === null) {
    try {
      keeperLog = openSync(resolve(CONFIG.stateDir, "keeper.log"), "a");
    } catch {
      keeperLog = false; // state dir not open yet — console only
    }
  }
  if (keeperLog) {
    try {
      writeFileSync(keeperLog, `${line}\n`);
    } catch {
      /* keep going — logging must never kill an update */
    }
  }
}

function rotateIfNeeded(file) {
  try {
    if (statSync(file).size > 5 * 1024 * 1024) {
      renameSync(file, `${file}.old`);
    }
  } catch {
    /* missing file = nothing to rotate */
  }
}

// ---------------------------------------------------------------------------
// Git plumbing
// ---------------------------------------------------------------------------

function git(args, opts = {}) {
  return new Promise((res, rej) => {
    execFile(
      "git",
      args,
      { cwd: ROOT, maxBuffer: 8 * 1024 * 1024, timeout: 120_000, ...opts },
      (err, stdout, stderr) =>
        err
          ? rej(new Error(`git ${args.join(" ")}: ${stderr || err.message}`))
          : res(stdout.trim()),
    );
  });
}

// ---------------------------------------------------------------------------
// State: state.json, history.log, breaker marker
// ---------------------------------------------------------------------------

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE(), "utf8"));
  } catch {
    return { lastGoodSha: null, lastGoodAt: null, failures: 0 };
  }
}
function writeState(state) {
  writeFileSync(STATE_FILE(), `${JSON.stringify(state, null, 2)}\n`);
}
function history(outcome, detail) {
  appendFileSync(HISTORY_FILE(), `${new Date().toISOString()}  ${outcome}  ${detail}\n`);
}
function breakerTripped(state) {
  return state.failures >= CONFIG.maxFailures || existsSync(DISABLED_FILE());
}
function tripBreaker(reason) {
  writeFileSync(DISABLED_FILE(), `${reason}\n`);
}

// ---------------------------------------------------------------------------
// Lock — guards against two keepers racing (loop + a manual --once)
// ---------------------------------------------------------------------------

let lockFd = null;
function acquireLock() {
  mkdirSync(CONFIG.stateDir, { recursive: true });
  try {
    // 0o666, not W_OK: a write-only creation mode (no read bit) fails with
    // EPERM on Windows the moment the file does not already exist.
    lockFd = openSync(LOCK_FILE(), "wx", 0o666);
  } catch {
    // Existing lock: steal it when the holder is dead, refuse when alive.
    let holder = null;
    try {
      holder = JSON.parse(readFileSync(LOCK_FILE(), "utf8"));
    } catch {
      /* corrupt lock — steal below */
    }
    if (holder?.pid) {
      try {
        process.kill(holder.pid, 0);
      } catch (e) {
        if (e.code === "ESRCH") {
          log(`lock held by dead pid ${holder.pid} — taking over`);
        } else {
          return `another keeper is running (pid ${holder.pid})`;
        }
      }
    }
    try {
      unlinkSync(LOCK_FILE());
    } catch {
      /* gone already — retry exclusive create */
    }
    try {
      // 0o666 — see comment above; W_OK as a creation mode EPERMs on Windows.
      lockFd = openSync(LOCK_FILE(), "wx", 0o666);
    } catch {
      return "another keeper is running";
    }
  }
  writeSyncLock(process.pid);
  return null;
}
function writeSyncLock(pid) {
  writeFileSync(LOCK_FILE(), `${JSON.stringify({ pid })}\n`);
}
function releaseLock() {
  if (lockFd !== null) {
    try {
      closeSync(lockFd);
    } catch {
      /* already closed */
    }
    lockFd = null;
    try {
      unlinkSync(LOCK_FILE());
    } catch {
      /* someone else took it */
    }
  }
}

// ---------------------------------------------------------------------------
// Health probes
// ---------------------------------------------------------------------------

async function urlAlive(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (res.status < 500) return { alive: true, status: res.status };
    // 503 from the gateway: still alive when the gateway itself is ok and a
    // backing service is what failed (see CONFIG.healthUrls comment).
    const body = await res.json().catch(() => null);
    const gatewayOk = body?.gateway?.ok === true;
    return { alive: gatewayOk, status: res.status };
  } catch {
    return { alive: false, status: 0 };
  }
}

async function healthSnapshot() {
  const results = await Promise.all(
    CONFIG.healthUrls.map(async (url) => ({ url, ...(await urlAlive(url)) })),
  );
  return {
    healthy: results.every((r) => r.alive),
    detail: results
      .map((r) => `${r.url} ${r.alive ? "ok" : `DOWN(${r.status || "no-answer"})`}`)
      .join(", "),
  };
}

async function waitForHealth(timeoutS) {
  const deadline = Date.now() + timeoutS * 1000;
  let last = null;
  while (Date.now() < deadline) {
    last = await healthSnapshot();
    if (last.healthy) return last;
    await sleep(2_000);
  }
  return last;
}

// ---------------------------------------------------------------------------
// Process discovery + restart (Windows host)
// ---------------------------------------------------------------------------

function listenersOn(port) {
  return new Promise((res, rej) => {
    execFile(
      "netstat",
      ["-ano"],
      { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
      (err, stdout) => {
        if (err) return rej(err);
        const pids = new Set();
        for (const line of stdout.split("\n")) {
          const cols = line.trim().split(/\s+/);
          // TCP  0.0.0.0:8787  0.0.0.0:0  LISTENING  23916
          if (cols[3] === "LISTENING" && cols[1]?.endsWith(`:${port}`)) {
            const pid = Number(cols[4]);
            if (pid > 0) pids.add(pid);
          }
        }
        res([...pids]);
      },
    );
  });
}

function killTree(pid) {
  return new Promise((res) => {
    // /T = tree (session-host children go too; the gateway's mid-turn reap
    // path degrades those threads cleanly — that is a supported restart).
    // /F is required: console node has no window to close, so a soft
    // taskkill is a no-op.
    execFile("taskkill", ["/F", "/T", "/PID", String(pid)], { timeout: 15_000 }, () => res());
  });
}

function spawnDetached(cmd, args, cwd, logFile) {
  rotateIfNeeded(logFile);
  const out = openSync(logFile, "a");
  appendFileSync(
    out,
    `\n===== spawn ${new Date().toISOString()}: ${cmd} ${args.join(" ")} (cwd ${cwd})\n`,
  );
  const child = spawn(cmd, args, {
    cwd,
    detached: true, // DETACHED_PROCESS on win32 — survives this keeper's exit
    windowsHide: true,
    stdio: ["ignore", out, out],
  });
  child.once("error", (e) => log(`spawn error (${cmd}): ${e.message}`));
  child.unref();
  closeSync(out);
  return child.pid;
}

function launchGateway() {
  const cwd = resolve(ROOT, "apps/gateway");
  if (CONFIG.gatewayCmd) {
    return spawnDetached(CONFIG.gatewayCmd, [], cwd, resolve(CONFIG.stateDir, "gateway.log"));
  }
  return spawnDetached(
    process.execPath,
    // Same invocation as `pnpm --filter @aelvyril/gateway start`: node loads
    // apps/gateway/.env itself via --env-file-if-exists, tsx runs TS directly
    // (no build step — "build" is a typecheck-only script).
    ["--env-file-if-exists=.env", "--import", "tsx", "src/index.ts"],
    cwd,
    resolve(CONFIG.stateDir, "gateway.log"),
  );
}

function launchWeb() {
  const cwd = resolve(ROOT, "apps/web");
  if (CONFIG.webCmd) {
    return spawnDetached(CONFIG.webCmd, [], cwd, resolve(CONFIG.stateDir, "web.log"));
  }
  const nextBin = resolve(cwd, "node_modules/next/dist/bin/next");
  if (!existsSync(nextBin)) {
    throw new Error(`next CLI not found at ${nextBin} — run pnpm install`);
  }
  return spawnDetached(
    process.execPath,
    [nextBin, "dev", "--webpack", "-p", String(CONFIG.webPort)],
    cwd,
    resolve(CONFIG.stateDir, "web.log"),
  );
}

/** Kill whatever listens on the ports, then relaunch fresh. */
async function restartServices(services) {
  const kills = [];
  if (services.gateway) {
    for (const pid of await listenersOn(CONFIG.gatewayPort)) {
      log(`gateway: killing pid ${pid}`);
      kills.push(killTree(pid));
    }
  }
  if (services.web) {
    for (const pid of await listenersOn(CONFIG.webPort)) {
      log(`web: killing pid ${pid}`);
      kills.push(killTree(pid));
    }
  }
  await Promise.all(kills);
  await sleep(1_000); // let the ports release
  const pids = {};
  if (services.gateway) pids.gateway = launchGateway();
  if (services.web) pids.web = launchWeb();
  log(
    `relaunched: ${
      Object.entries(pids)
        .map(([n, p]) => `${n} pid ${p}`)
        .join(", ") || "nothing"
    }`,
  );
  return pids;
}

// ---------------------------------------------------------------------------
// Update planning: what did the incoming range actually touch?
// ---------------------------------------------------------------------------

async function affectedServices(fromSha, toSha) {
  const paths = (await git(["diff", "--name-only", `${fromSha}..${toSha}`]))
    .split("\n")
    .filter(Boolean);
  const install = paths.includes("pnpm-lock.yaml");
  const touches = (prefix) => paths.some((p) => p.startsWith(prefix));
  return {
    install,
    // packages/shared is workspace-linked into both apps — touch it and
    // both services bounce; otherwise only the app whose files changed.
    gateway: touches("apps/gateway/") || touches("packages/"),
    web: touches("apps/web/") || touches("packages/"),
  };
}

// ---------------------------------------------------------------------------
// Optional CI gate (SELF_UPDATE_REQUIRE_CI=1): origin/main must be green
// ---------------------------------------------------------------------------

async function ciGreen(sha) {
  const remote = await git(["remote", "get-url", "origin"]);
  const m = remote.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/);
  if (!m) {
    log(`CI gate: origin is not github.com (${remote}) — skipping gate`);
    return true;
  }
  const [, owner, repo] = m;
  let token = "";
  try {
    const cred = await new Promise((res, rej) => {
      const p = execFile("git", ["credential", "fill"], { timeout: 15_000 }, (e, stdout) =>
        e ? rej(e) : res(stdout),
      );
      p.stdin?.end("protocol=https\nhost=github.com\n\n");
    });
    token =
      cred
        .split("\n")
        .find((l) => l.startsWith("password="))
        ?.slice(9) ?? "";
  } catch {
    /* no stored credential — proceed unauthenticated below */
  }
  const headers = { accept: "application/vnd.github+json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/check-runs`,
    {
      headers,
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    log(`CI gate: check-runs API answered ${res.status} — skipping gate`);
    return true; // fail-open: an API hiccup must not wedge the loop
  }
  const { total_count: total, check_runs: runs } = await res.json();
  if (!total) {
    log(`CI gate: no check runs on ${sha.slice(0, 7)} — skipping gate`);
    return true;
  }
  const bad = runs.filter((r) => r.conclusion !== "success" && r.conclusion !== "skipped");
  if (bad.length) {
    log(
      `CI gate: NOT green on ${sha.slice(0, 7)} — ${bad.map((r) => `${r.name}:${r.conclusion}`).join(", ")}`,
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The update cycle
// ---------------------------------------------------------------------------

async function runCycle({ force = false } = {}) {
  const state = readState();

  // Gate 0 — breaker: repeated bad updates stop the loop until an operator
  // clears it (delete .self-update/disabled or run --reset).
  if (breakerTripped(state)) {
    log(
      `breaker tripped (${state.failures} consecutive failures) — refusing to update until --reset`,
    );
    return 6;
  }

  // Gate 1 — only update a healthy stack ("update when it's running ok"):
  // keeps the last-known-good assumption behind rollback honest.
  const pre = await healthSnapshot();
  if (!pre.healthy) {
    log(`stack not healthy before update (${pre.detail}) — skipping${force ? " (--force)" : ""}`);
    return force ? 0 : 2;
  }

  await git(["fetch", "origin"]);
  const head = await git(["rev-parse", "HEAD"]);
  const target = await git(["rev-parse", originRef()]);
  if (head === target) {
    log(`up to date at ${head.slice(0, 7)}`);
    return 0;
  }
  const behind = Number((await git(["rev-list", "--count", `${head}..${target}`])) || 0);
  if (behind === 0) {
    // head != target but nothing to pull — local commits origin lacks.
    log(`HEAD ${head.slice(0, 7)} is not behind ${originRef()} (local commits?) — nothing to pull`);
    return 2;
  }
  log(
    `update available: ${head.slice(0, 7)} -> ${target.slice(0, 7)} (${behind} commit${behind === 1 ? "" : "s"})`,
  );

  // Gate 2 — CI (opt-in): never deploy a red commit.
  if (CONFIG.requireCi && !(await ciGreen(target))) return 2;

  // Gate 3 — clean tree: generated files are auto-restored; ANY other local
  // modification blocks the update. Never clobber operator work.
  const dirty = (await git(["status", "--porcelain"])).split("\n").filter(Boolean);
  const blocking = [];
  for (const line of dirty) {
    // Porcelain v1: two status columns, one space, then the path. slice(2)
    // (not slice(3)) — a leading status column may already be gone when the
    // overall output was trimmed.
    const path = line.slice(2).trim();
    if (CONFIG.allowlist.includes(path)) {
      await git(["checkout", "--", path]);
    } else {
      blocking.push(path);
    }
  }
  if (blocking.length) {
    log(`working tree has local changes — skipping: ${blocking.join(", ")}`);
    return 2;
  }

  const plan = await affectedServices(head, target);
  log(
    `plan: install=${plan.install} restart=[${[plan.gateway && "gateway", plan.web && "web"].filter(Boolean).join(", ") || "none"}]`,
  );

  // Apply.
  const prevSha = head;
  let merged = false;
  try {
    await git(["merge", "--ff-only", originRef()]);
    merged = true;
    log(`merged ${originRef()} -> ${target.slice(0, 7)}`);
    if (plan.install) {
      log("pnpm-lock.yaml changed — pnpm install --frozen-lockfile");
      await runInShell("pnpm install --frozen-lockfile --prefer-offline", ROOT);
    }
    if (plan.web && CONFIG.webBuild) {
      log("web build enabled — next build");
      await runInShell("pnpm --filter @aelvyril/web build", ROOT);
    }
  } catch (e) {
    log(`apply failed: ${e.message}`);
    if (!merged) return 2; // nothing moved — plain skip
    return rollback({ prevSha, services: plan, state, reason: "apply failed mid-update" });
  }

  // Verify: restart only what changed, then demand a healthy stack.
  if (plan.gateway || plan.web) {
    await restartServices(plan);
    const post = await waitForHealth(CONFIG.healthTimeoutS);
    if (!post?.healthy) {
      log(`post-update verification FAILED (${post?.detail ?? "timeout"})`);
      return rollback({
        prevSha,
        services: plan,
        state,
        reason: "post-update health check failed",
      });
    }
    log(`verified healthy: ${post.detail}`);
  } else {
    log("no runtime files changed — no restart needed");
  }

  writeState({
    lastGoodSha: target,
    lastGoodAt: new Date().toISOString(),
    failures: 0,
    updatedAt: new Date().toISOString(),
  });
  history("applied-ok", `${prevSha.slice(0, 7)} -> ${target.slice(0, 7)}`);
  log(`update complete: now at ${target.slice(0, 7)}`);

  // The keeper just updated its own code — replace this process with a
  // fresh one in loop mode so new keeper logic takes over immediately.
  if (process.argv.includes("--loop")) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--loop"], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.unref();
    log(`keeper restarted itself (pid ${child.pid}) to pick up new code`);
    process.exit(0);
  }
  return 0;
}

function originRef() {
  return process.env.SELF_UPDATE_REF ?? "origin/main";
}

function runInShell(cmdline, cwd) {
  return new Promise((res, rej) => {
    const child = spawn(cmdline, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("exit", (code) =>
      code === 0
        ? res(out)
        : rej(new Error(`${cmdline} exited ${code}: ${out.split("\n").slice(-15).join("\n")}`)),
    );
  });
}

/** Restore prevSha + relaunch + verify. Returns the once-mode exit code. */
async function rollback({ prevSha, services, state, reason }) {
  log(`ROLLBACK: ${reason} — restoring ${prevSha.slice(0, 7)}`);
  const failures = state.failures + 1;
  try {
    await git(["reset", "--hard", prevSha]);
    history("rolled-back", `to ${prevSha.slice(0, 7)} (${reason})`);
  } catch (e) {
    tripBreaker(`rollback git reset failed: ${e.message}`);
    history("rollback-failed", `reset ${prevSha.slice(0, 7)}: ${e.message}`);
    log(`rollback git reset FAILED — breaker tripped, manual intervention required`);
    return 5;
  }
  try {
    // The failed attempt may have changed the lockfile — reinstall so the
    // restored tree runs against its own dependency set.
    const plan = await affectedServices(prevSha, await git(["rev-parse", originRef()]));
    if (plan.install) await runInShell("pnpm install --frozen-lockfile --prefer-offline", ROOT);
    await restartServices(services);
    const post = await waitForHealth(CONFIG.healthTimeoutS);
    if (!post?.healthy)
      throw new Error(`still unhealthy after rollback: ${post?.detail ?? "timeout"}`);
    log(`rollback verified healthy: ${post.detail}`);
    writeState({ ...state, failures, updatedAt: new Date().toISOString() });
    if (failures >= CONFIG.maxFailures) {
      tripBreaker(`${failures} consecutive failed updates (last: ${reason})`);
      log("breaker tripped — auto-updates stopped until --reset");
    }
    return 4;
  } catch (e) {
    tripBreaker(`rollback failed: ${e.message}`);
    history("rollback-failed", `${e.message}`);
    log(`rollback FAILED — breaker tripped, manual intervention required`);
    return 5;
  }
}

// ---------------------------------------------------------------------------
// Operator commands
// ---------------------------------------------------------------------------

async function cmdStatus() {
  const state = readState();
  const head = await git(["rev-parse", "HEAD"]).catch(() => "?");
  const remote = await git(["rev-parse", originRef()]).catch(() => "?");
  const snap = await healthSnapshot();
  console.log(
    JSON.stringify(
      {
        head,
        remote,
        behind: head === remote ? 0 : "?",
        health: snap.detail,
        healthy: snap.healthy,
        state,
        breaker: breakerTripped(state)
          ? existsSync(DISABLED_FILE())
            ? "tripped"
            : "at-limit"
          : "clear",
      },
      null,
      2,
    ),
  );
  return 0;
}

async function cmdRestart() {
  log("manual restart requested");
  await restartServices({ gateway: true, web: true });
  const post = await waitForHealth(CONFIG.healthTimeoutS);
  if (!post?.healthy) {
    log(`restart verification FAILED (${post?.detail ?? "timeout"})`);
    return 3;
  }
  log(`restart verified healthy: ${post.detail}`);
  // A verified restart proves current HEAD runs — seed the rollback target
  // so --rollback works before the first keeper-driven apply ever happens.
  const state = readState();
  const head = await git(["rev-parse", "HEAD"]).catch(() => null);
  if (head && state.lastGoodSha !== head) {
    writeState({
      ...state,
      lastGoodSha: head,
      lastGoodAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    history("last-good", `${head.slice(0, 7)} (verified restart)`);
  }
  return 0;
}

async function cmdRollback(sha) {
  const state = readState();
  const target = sha ?? state.lastGoodSha;
  if (!target) {
    log("no sha given and state.json has no lastGoodSha — nothing to roll back to");
    return 1;
  }
  const cur = await git(["rev-parse", "HEAD"]);
  if (cur === target) {
    log(`already at ${target.slice(0, 7)} — restarting instead`);
    return cmdRestart();
  }
  const code = await rollback({
    prevSha: target,
    services: { gateway: true, web: true },
    state,
    reason: `manual rollback to ${target.slice(0, 7)}`,
  });
  return code === 4 ? 0 : code; // a successful manual rollback is exit 0
}

async function cmdReset() {
  const state = readState();
  state.failures = 0;
  writeState(state);
  try {
    unlinkSync(DISABLED_FILE());
  } catch {
    /* not tripped */
  }
  log("failure counter cleared, breaker reset");
  return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const loop = args.includes("--loop");
  const force = args.includes("--force") || envFlag("SELF_UPDATE_FORCE", false);
  mkdirSync(CONFIG.stateDir, { recursive: true });

  const held = acquireLock();
  if (held) {
    console.error(`self-update: ${held}`);
    return 7;
  }
  process.on("exit", releaseLock);
  process.on("SIGINT", () => process.exit(130));

  if (args.includes("--status")) return cmdStatus();
  if (args.includes("--reset")) return cmdReset();
  if (args.includes("--restart")) return cmdRestart();
  const rbIdx = args.indexOf("--rollback");
  if (rbIdx !== -1)
    return cmdRollback(
      args[rbIdx + 1] && !args[rbIdx + 1].startsWith("--") ? args[rbIdx + 1] : undefined,
    );

  if (!loop) return runCycle({ force });

  log(
    `keeper loop started (pid ${process.pid}, interval ${CONFIG.intervalS}s, state ${CONFIG.stateDir})`,
  );
  for (;;) {
    let code = 0;
    try {
      code = await runCycle({ force });
    } catch (e) {
      log(`cycle error: ${e.message}`);
      code = 2;
    }
    if (code === 6) {
      log("breaker disabled the loop — exiting; run --reset to re-enable");
      return 6;
    }
    await sleep(CONFIG.intervalS * 1000);
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((e) => {
    console.error(`self-update: fatal: ${e.message}`);
    process.exit(1);
  });
