// Drives the REAL gateway with REAL pi (the user's `pi` on PATH or PI_COMMAND) against the scripted mock model,
// to prove the finish contract end to end: the task-guard extension, finish_task, nudges, need_input, send-back, the stall watchdog.
//   node e2e/task-guard.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const data = mkdtempSync(join(tmpdir(), "aelvyril-guard-"));
mkdirSync(join(data, "pi"), { recursive: true });
writeFileSync(join(data, "pi", "models.json"), JSON.stringify({ providers: { spikeai: { baseUrl: "http://127.0.0.1:18778/v1", api: "openai-completions", apiKey: "sk-x", models: [{ id: "spike-1", name: "Spike 1" }] } } }));
writeFileSync(join(data, "pi", "settings.json"), JSON.stringify({ defaultProvider: "spikeai", defaultModel: "spike-1" }));

const procs = [];
const run = (cmd, args, env = {}) => {
  const p = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", () => {});
  p.stderr.on("data", () => {});
  procs.push(p);
  return p;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B = "http://127.0.0.1:3095";
let cookie = "";
const api = async (path, init = {}) => {
  const res = await fetch(B + path, { ...init, headers: { "content-type": "application/json", origin: B, cookie, ...init.headers } });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => ({})) };
};
const until = async (f, what, ms = 90000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await sleep(250);
  }
};

try {
  run("node", ["e2e/mock-model.mjs"], { MOCK_PORT: "18778" }); // its own port, so it never shares counters with a mock started for the browser test
  run("node", ["apps/gateway/src/index.ts"], {
    AELVYRIL_DATA: data, PORT: "3095", HOST: "127.0.0.1", AELVYRIL_OPEN_SETUP: "1",
    PI_COMMAND: process.env.PI_COMMAND ?? "pi",
    AELVYRIL_TASK_STALL_MS: "4000", AELVYRIL_WATCHDOG_MS: "500", // small, so the stall scenario is quick
  });
  await until(async () => (await fetch(B + "/api/health").catch(() => null))?.ok, "gateway");
  const su = await fetch(B + "/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json", origin: B }, body: JSON.stringify({ email: "a@b.co", password: "correct-horse-1", name: "A" }) });
  cookie = su.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const main = (await api("/api/main")).json;
  const stats = async () => (await (await fetch("http://127.0.0.1:18778/_stats")).json());

  // one main conversation, many tasks: start each scenario and watch the task row
  const start = async (scenario, extra = "") => {
    const before = new Set((await api("/api/threads")).json.filter((t) => t.kind === "job").map((t) => t.id));
    assert.equal((await api(`/api/threads/${main.id}/prompt`, { method: "POST", body: JSON.stringify({ message: `please do-job:${scenario} ${extra}` }) })).status, 200);
    return until(async () => (await api("/api/threads")).json.find((t) => t.kind === "job" && !before.has(t.id)), `a task for ${scenario}`);
  };
  const task = (id) => api("/api/threads").then((r) => r.json.find((t) => t.id === id));
  const settled = (id, status, what) => until(async () => { const t = await task(id); return t.status === status && !t.running ? t : null; }, what);

  console.log("• done: declares done and says how it checked; its summary is the result");
  let t = await start("done");
  t = await settled(t.id, "done", "done task");
  assert.equal(t.preview, "job-ok");
  const s1 = await stats();
  assert.equal(s1.finishTaskCalls.done, 1, "accepted at once: it said what it checked");

  console.log("• guides: the Stream's and the task's model are both offered the aelvyril guides; the Stream can open one and check its setup");
  for (const [who, sys] of [["the Stream", s1.mainSystem], ["a task", s1.taskSystem]])
    for (const g of ["aelvyril-app", "aelvyril-tasks", "aelvyril-coding", "aelvyril-look", "aelvyril-limits"]) assert.ok(sys.includes(`<name>${g}</name>`), `${who} is offered ${g}`);
  const say = async (message, what) => {
    const n = (await stats()).requests;
    assert.equal((await api(`/api/threads/${main.id}/prompt`, { method: "POST", body: JSON.stringify({ message }) })).status, 200);
    await until(async () => { const s = await stats(); return s.requests >= n + 2 && !(await api("/api/threads")).json.find((t) => t.id === main.id).running ? s : null; }, what);
    return (await stats()).lastToolResult;
  };
  assert.match(await say("do-guide", "the Stream reading a guide"), /# What you cannot do/, "the Stream's read reaches the guide on disk");
  assert.match(await say("do-abilities", "get_abilities"), /AI for chats: spike-1 \(spikeai\)\nAI for tasks: the same as chats/);

  console.log("• silent: never declares an outcome, so the guard nudges 3 times, then it is reported as NOT finished");
  t = await start("silent");
  t = await settled(t.id, "failed", "silent task failing");
  assert.equal(t.preview, "It stopped before it was finished.");
  const s2 = await stats();
  assert.equal(s2.nudgesSeen.silent, 3, "exactly 3 nudges before giving up");

  console.log("• nudged: forgets at first, finishes after one nudge");
  t = await start("nudged");
  t = await settled(t.id, "done", "nudged task finishing");
  assert.equal((await stats()).nudgesSeen.nudged, 1);

  console.log("• testing guardrail: changed a file but did not check it -> 'done' is refused until it re-reads the result");
  t = await start("untested");
  t = await settled(t.id, "done", "untested task finishing after a real check");
  assert.equal((await stats()).finishTaskCalls.untested, 2, "the first done was refused, the second (after reading the file) accepted");

  console.log("• testing guardrail: 'done' without saying what was checked is refused");
  t = await start("noverify");
  t = await settled(t.id, "done", "noverify task");
  assert.equal((await stats()).finishTaskCalls.noverify, 2);

  console.log("• testing guardrail: keeps declaring done without testing -> recorded honestly as not tested (failed), never done");
  t = await start("neverchecks");
  t = await settled(t.id, "failed", "neverchecks task failing");
  assert.equal(t.preview, "Couldn't finish: It could not show that the result was tested.");
  assert.equal((await stats()).finishTaskCalls.neverchecks, 4, "refused 4 times, then recorded as not tested");
  console.log("• retry: the failed task is tried again as a new round (nothing changed in it this time, so a checked 'done' is accepted)");
  const before = (await stats()).finishTaskCalls.neverchecks;
  assert.equal((await api(`/api/threads/${t.id}/retry`, { method: "POST" })).status, 200);
  t = await settled(t.id, "done", "retried task finishing");
  assert.ok((await stats()).finishTaskCalls.neverchecks > before, "the retry round ran");
  assert.equal((await api(`/api/threads/${t.id}/retry`, { method: "POST" })).status, 400, "a finished task cannot be retried");

  console.log("• cannot: an honest failure with its reason");
  t = await start("cannot");
  t = await settled(t.id, "failed", "cannot task");
  assert.equal(t.preview, "Couldn't finish: there is no network");

  console.log("• need: asks one question (needs you), then finishes after the person answers");
  t = await start("need");
  t = await until(async () => { const x = await task(t.id); return x.status === "needs_you" && !x.running ? x : null; }, "need_input");
  assert.equal(t.preview, "Which folder?");
  assert.equal((await api(`/api/threads/${t.id}/prompt`, { method: "POST", body: JSON.stringify({ message: "the photos folder" }) })).status, 200);
  t = await settled(t.id, "done", "need task finishing after the answer");

  console.log("• send-back: a partial result goes back to the task once, and its full result comes back");
  t = await start("sendback");
  t = await until(async () => { const x = await task(t.id); return x.status === "done" && !x.running && x.preview === "job-full" ? x : null; }, "sent-back task finishing again");
  assert.equal((await stats()).finishTaskCalls.sendback, 2, "done, sent back, done again");
  assert.equal((await stats()).continueJobCalls, 1, "sent back once, not again for the full result");

  console.log("• hang: the model never answers; the watchdog stops the task instead of waiting forever");
  t = await start("hang");
  t = await settled(t.id, "failed", "hang task failing");
  assert.equal(t.preview, "Couldn't finish: it stopped responding");

  console.log("• the main conversation heard about every outcome (cards + messages)");
  const log = await new Promise(async (resolveLog) => {
    const res = await fetch(`${B}/api/threads/${main.id}/events?after=0`, { headers: { cookie } });
    let buf = "";
    const rd = res.body.getReader();
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) { const r = await Promise.race([rd.read(), sleep(1500).then(() => ({ done: true }))]); if (r.done) break; buf += new TextDecoder().decode(r.value); }
    rd.cancel().catch(() => {});
    resolveLog(buf.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))));
  });
  const states = log.filter((e) => e.type === "aelvyril_job_update").map((e) => e.state);
  for (const s of ["done", "failed", "needs_you"]) assert.ok(states.includes(s), `a card update with state ${s}`);
  console.log("TASK GUARD E2E PASSED");
} finally {
  for (const p of procs) p.kill();
}
