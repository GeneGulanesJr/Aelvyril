import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "./server.ts";
import { loadConfig } from "./config.ts";

const dir = mkdtempSync(join(tmpdir(), "aelvyril-test-"));
let gw: Awaited<ReturnType<typeof createGateway>>;
let cookie = "";

before(async () => {
  const cfg = loadConfig({
    AELVYRIL_DATA: dir,
    PI_COMMAND: process.execPath,
    PI_ARGS: join(import.meta.dirname, "fake-pi.mjs"),
    AELVYRIL_WEB: join(dir, "no-web"),
  });
  gw = await createGateway(cfg);
});
after(() => {
  gw.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (path: string, init: RequestInit & { json?: unknown } = {}) =>
  gw.app.request(path, {
    ...init,
    headers: { cookie, origin: "http://localhost", "content-type": "application/json", ...init.headers },
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
  });
const until = async (f: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

test("API is closed without a session", async () => {
  assert.equal((await call("/api/threads")).status, 401);
  assert.equal((await (await call("/api/setup")).json()).needsSetup, true);
});

test("sign-up needs the setup code", async () => {
  const res = await gw.app.request("http://localhost/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost", "x-setup-code": "wrong" },
    body: JSON.stringify({ email: "me@example.com", password: "correct-horse-1", name: "Me" }),
  });
  assert.equal(res.status, 403);
});

test("first sign-up works, then sign-up closes", async () => {
  const res = await gw.app.request("http://localhost/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost", "x-setup-code": gw.auth.setupCode()! },
    body: JSON.stringify({ email: "me@example.com", password: "correct-horse-1", name: "Me" }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  assert.ok(cookie.includes("session_token"));
  assert.equal((await call("/api/threads")).status, 200);
  const again = await gw.app.request("http://localhost/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost", "x-setup-code": "anything" },
    body: JSON.stringify({ email: "x@example.com", password: "correct-horse-1", name: "X" }),
  });
  assert.equal(again.status, 403);
});

test("a cross-site Origin is refused by auth", async () => {
  const res = await gw.app.request("http://localhost/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://evil.example" },
    body: JSON.stringify({ email: "me@example.com", password: "correct-horse-1" }),
  });
  assert.equal(res.status, 403);
});

test("prompt round-trip is logged and replayable", async () => {
  const t = await (await call("/api/threads", { method: "POST", json: {} })).json();
  const res = await call(`/api/threads/${t.id}/prompt`, { method: "POST", json: { message: "hello" } });
  assert.equal(res.status, 200, await res.clone().text());
  await until(() => gw.sup.eventsAfter(t.id).some((e) => e.type === "agent_settled"));
  const types = gw.sup.eventsAfter(t.id).map((e) => e.type);
  assert.ok(types.includes("aelvyril_host_start"));
  assert.ok(!types.includes("message_update"), "streaming deltas are live-only");
  const assistant = gw.sup.eventsAfter(t.id).find((e) => e.type === "message_end" && e.data.message.role === "assistant");
  assert.equal(assistant?.data.message.content[0].text, "echo: hello");
  assert.equal(gw.sup.getThread(t.id)?.title, "hello", "title comes from the first prompt");

  // SSE replay honours Last-Event-ID
  const all = gw.sup.eventsAfter(t.id);
  const sse = await call(`/api/threads/${t.id}/events`, { headers: { "last-event-id": String(all[all.length - 2].seq) } });
  const reader = sse.body!.getReader();
  const text = new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.match(text, new RegExp(`id: ${all[all.length - 1].seq}`));
  assert.ok(!text.includes(`id: ${all[all.length - 2].seq}\n`));
});

test("extension dialog: pending until answered, then the extension continues", async () => {
  const t = await (await call("/api/threads", { method: "POST", json: {} })).json();
  await call(`/api/threads/${t.id}/prompt`, { method: "POST", json: { message: "/ask" } });
  await until(() => gw.sup.eventsAfter(t.id).some((e) => e.type === "extension_ui_request"));
  assert.equal(gw.sup.listThreads().find((x) => x.id === t.id)?.waiting, 1);

  const bad = await call(`/api/threads/${t.id}/ui-response`, { method: "POST", json: { id: "nope", confirmed: true } });
  assert.equal(bad.status, 404);
  const ok = await call(`/api/threads/${t.id}/ui-response`, { method: "POST", json: { id: "ui-1", confirmed: true } });
  assert.equal(ok.status, 200);
  await until(() => gw.sup.eventsAfter(t.id).some((e) => e.type === "entry_appended"));
  const evs = gw.sup.eventsAfter(t.id);
  assert.ok(evs.some((e) => e.type === "aelvyril_ui_resolved" && e.data.id === "ui-1"));
  assert.equal(evs.find((e) => e.type === "entry_appended")?.data.entry.data.body, "confirmed=true");
  assert.equal(gw.sup.listThreads().find((x) => x.id === t.id)?.waiting, 0);
});

test("abort cancels a waiting dialog", async () => {
  const t = await (await call("/api/threads", { method: "POST", json: {} })).json();
  await call(`/api/threads/${t.id}/prompt`, { method: "POST", json: { message: "/ask" } });
  await until(() => gw.sup.listThreads().find((x) => x.id === t.id)!.waiting === 1);
  await call(`/api/threads/${t.id}/abort`, { method: "POST" });
  assert.equal(gw.sup.listThreads().find((x) => x.id === t.id)?.waiting, 0);
});

test("models list and delete", async () => {
  assert.deepEqual(await (await call("/api/models")).json(), [{ provider: "fake", id: "fake-1" }]);
  const t = await (await call("/api/threads", { method: "POST", json: {} })).json();
  assert.equal((await call(`/api/threads/${t.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await call(`/api/threads/${t.id}/prompt`, { method: "POST", json: { message: "x" } })).status, 404);
});

// ---- providers, extensions, settings (all through the UI's API) ----------
import { existsSync, readFileSync, statSync } from "node:fs";
import { normalizeSource } from "./extensions.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const poll = async (sid: string, want: (e: any) => boolean) => {
  for (let i = 0; i < 80; i++) {
    const r = await (await call(`/api/login/${sid}?after=0`)).json();
    const hit = r.events.find(want);
    if (hit) return { hit, events: r.events };
    await sleep(50);
  }
  throw new Error("login event never arrived");
};

test("providers: the list is plain data, with connect options", async () => {
  const r = await (await call("/api/providers")).json();
  const anthropic = r.providers.find((p: any) => p.id === "anthropic");
  assert.ok(anthropic.apiKey && anthropic.oauth);
  assert.equal(r.defaultModel, null);
});

test("custom endpoint: validated, saved, key never sent back, file is owner-only", async () => {
  const bad = await call("/api/custom-providers/my-llm", { method: "PUT", json: { baseUrl: "not a url", models: [{ id: "m" }] } });
  assert.equal(bad.status, 400);
  const noModels = await call("/api/custom-providers/my-llm", { method: "PUT", json: { baseUrl: "http://127.0.0.1:1234/v1", models: [] } });
  assert.equal(noModels.status, 400);
  const ok = await call("/api/custom-providers/my-llm", { method: "PUT", json: { baseUrl: "http://127.0.0.1:1234/v1/", apiKey: "sk-secret-123", models: [{ id: "qwen", name: "Qwen" }] } });
  assert.equal(ok.status, 200);
  const text = await (await call("/api/providers")).text();
  assert.ok(!text.includes("sk-secret-123"), "the key must not come back to the browser");
  const r = JSON.parse(text);
  assert.deepEqual(r.custom[0], { id: "my-llm", baseUrl: "http://127.0.0.1:1234/v1", api: "openai-completions", models: [{ id: "qwen", name: "Qwen" }], hasKey: true });
  assert.equal(r.providers.find((p: any) => p.id === "my-llm")?.configured, true);
  const file = join(gw.cfg.piHome, "models.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // editing without a key keeps the stored one
  await call("/api/custom-providers/my-llm", { method: "PUT", json: { baseUrl: "http://127.0.0.1:1234/v1", models: [{ id: "qwen" }] } });
  assert.ok(readFileSync(file, "utf8").includes("sk-secret-123"));
  assert.equal((await call("/api/custom-providers/my-llm", { method: "DELETE" })).status, 200);
  assert.equal((await (await call("/api/providers")).json()).custom.length, 0);

  // a server that needs no key (LM Studio, Ollama) must still count as connected
  await call("/api/custom-providers/local-box", { method: "PUT", json: { baseUrl: "http://127.0.0.1:11434/v1", models: [{ id: "llama" }] } });
  const r2 = await (await call("/api/providers")).json();
  assert.equal(r2.custom[0].hasKey, false);
  assert.equal(r2.providers.find((p: any) => p.id === "local-box")?.configured, true);
  await call("/api/custom-providers/local-box", { method: "DELETE" });
});

test("API-key login runs as a guided session and stores the key", async () => {
  const start = await call("/api/providers/openrouter/login", { method: "POST", json: { type: "api_key" } });
  assert.equal(start.status, 200, await start.clone().text());
  const { sessionId } = await start.json();
  const { hit } = await poll(sessionId, (e) => e.type === "prompt");
  assert.ok(["secret", "text"].includes(hit.prompt.type), JSON.stringify(hit.prompt));
  const ans = await call(`/api/login/${sessionId}/answer`, { method: "POST", json: { promptId: hit.id, value: "sk-or-test-key" } });
  assert.equal(ans.status, 200);
  await poll(sessionId, (e) => e.type === "done");
  const auth = join(gw.cfg.piHome, "auth.json");
  assert.ok(readFileSync(auth, "utf8").includes("sk-or-test-key"));
  assert.equal(statSync(auth).mode & 0o777, 0o600);
  const p = (await (await call("/api/providers")).json()).providers.find((x: any) => x.id === "openrouter");
  assert.equal(p.configured, true);
  assert.ok(!JSON.stringify(p).includes("sk-or-test-key"));
  assert.equal((await call("/api/providers/openrouter/logout", { method: "POST" })).status, 200);
  assert.equal((await (await call("/api/providers")).json()).providers.find((x: any) => x.id === "openrouter").configured, false);
});

test("subscription login surfaces a sign-in link and can be cancelled", async () => {
  const { sessionId } = await (await call("/api/providers/anthropic/login", { method: "POST", json: { type: "oauth" } })).json();
  let answeredSelect = false;
  let link: any;
  for (let i = 0; i < 80 && !link; i++) {
    const r = await (await call(`/api/login/${sessionId}?after=0`)).json();
    const sel = r.events.find((e: any) => e.type === "prompt" && e.prompt.type === "select");
    if (sel && !answeredSelect) {
      answeredSelect = true;
      await call(`/api/login/${sessionId}/answer`, { method: "POST", json: { promptId: sel.id, value: sel.prompt.options[0].id } });
    }
    link = r.events.find((e: any) => e.type === "notify" && e.event.type === "auth_url");
    await sleep(50);
  }
  assert.match(link.event.url, /^https:\/\//);
  assert.equal((await call(`/api/login/${sessionId}`, { method: "DELETE" })).status, 200);
  await poll(sessionId, (e) => e.type === "error");
});

test("login for an unknown provider or bad type is refused", async () => {
  assert.equal((await call("/api/providers/nope/login", { method: "POST", json: { type: "api_key" } })).status, 400);
  assert.equal((await call("/api/providers/anthropic/login", { method: "POST", json: { type: "magic" } })).status, 400);
});

test("default model is saved in the pi home", async () => {
  assert.equal((await call("/api/default-model", { method: "PUT", json: { provider: "anthropic", modelId: "claude-x" } })).status, 200);
  assert.deepEqual((await (await call("/api/providers")).json()).defaultModel, { provider: "anthropic", modelId: "claude-x" });
});

test("extensions: friendly links become pi sources; install and remove from the UI", async () => {
  assert.deepEqual(normalizeSource("https://github.com/GeneGulanesJr/LaPis"), { source: "git:github.com/GeneGulanesJr/LaPis" });
  assert.deepEqual(normalizeSource("GeneGulanesJr/PiSync"), { source: "git:github.com/GeneGulanesJr/PiSync" });
  assert.deepEqual(normalizeSource("npm:@scope/pkg@1.2.0"), { source: "npm:@scope/pkg@1.2.0" });
  for (const bad of ["./local", "/etc/passwd", "git:evil.com/x/y", "owner/repo; rm -rf /", ""]) assert.ok("error" in normalizeSource(bad), bad);

  assert.equal((await call("/api/extensions", { method: "POST", json: { source: "../../x" } })).status, 400);
  const ok = await call("/api/extensions", { method: "POST", json: { source: "https://github.com/acme/tools" } });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.deepEqual((await (await call("/api/extensions")).json()).find((e: any) => e.source.endsWith("acme/tools")), { source: "git:github.com/acme/tools", name: "acme/tools", builtin: false });
  assert.equal((await call("/api/extensions", { method: "POST", json: { source: "acme/broken" } })).status, 502);
  assert.equal((await call("/api/extensions/remove", { method: "POST", json: { source: "git:github.com/acme/tools" } })).status, 200);
  assert.equal((await call("/api/extensions/remove", { method: "POST", json: { source: "git:github.com/acme/tools" } })).status, 502);
  assert.ok(!existsSync(join(gw.cfg.piHome, "nothing")));
});

test("models: an empty answer right after start is retried when an AI is connected", async () => {
  process.env.FAKE_MODELS_SLOW = "1";
  try {
    // connecting something restarts the helper process, which then answers empty twice
    await call("/api/custom-providers/slow-box", { method: "PUT", json: { baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "m" }] } });
    const models = await (await call("/api/models")).json();
    assert.equal(models.length, 1, "the model list must not stay empty while an AI is connected");
  } finally {
    delete process.env.FAKE_MODELS_SLOW;
    await call("/api/custom-providers/slow-box", { method: "DELETE" });
  }
});

test("models: a silent helper is replaced instead of hanging the page", async () => {
  process.env.FAKE_HANG_MARK = join(dir, "hang-mark");
  gw.sup.controlTimeoutMs = 400;
  try {
    await call("/api/custom-providers/hang-box", { method: "PUT", json: { baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "m" }] } });
    const started = Date.now();
    const models = await (await call("/api/models")).json();
    assert.equal(models.length, 1);
    assert.ok(Date.now() - started < 5000, "recovered within seconds, not 30s");
  } finally {
    delete process.env.FAKE_HANG_MARK;
    gw.sup.controlTimeoutMs = 15_000;
    await call("/api/custom-providers/hang-box", { method: "DELETE" });
  }
});

// ---- the Stream: one main conversation, jobs in the background ---------------
import { JOB_MARKER } from "./supervisor.ts";

test("the main conversation exists once, cannot be deleted, and has no extra tools of its own here", async () => {
  const a = await (await call("/api/main")).json();
  const b = await (await call("/api/main")).json();
  assert.equal(a.id, b.id);
  assert.equal(a.kind, "main");
  assert.equal((await call(`/api/threads/${a.id}`, { method: "DELETE" })).status, 400);
});

test("a job runs on its own and its result flows back to the main conversation", async () => {
  const main = gw.sup.main();
  const job = gw.sup.createJob(main.id, "Plan my week", "make a plan");
  assert.equal(job.kind, "job");
  assert.equal(job.parent_id, main.id);
  await until(() => gw.sup.getThread(job.id)?.state === "done");
  assert.equal(gw.sup.getThread(job.id)?.preview, "echo: make a plan");
  await until(() => gw.sup.eventsAfter(main.id).some((e) => e.type === "message_end" && e.data.message.role === "user" && String(e.data.message.content).startsWith(JOB_MARKER)));
  const log = gw.sup.eventsAfter(main.id);
  assert.ok(log.some((e) => e.type === "aelvyril_job_started" && e.data.jobId === job.id));
  assert.ok(log.some((e) => e.type === "aelvyril_job_update" && e.data.jobId === job.id && e.data.state === "done"));
  const listed = (await (await call("/api/threads")).json()).find((t: any) => t.id === job.id);
  assert.equal(listed.status, "done");
  assert.equal(listed.kind, "job");
  assert.equal(gw.sup.getThread(main.id)?.title, "Stream", "the main conversation is never renamed");
});

test("a job that waits for a yes shows as needs-you on its card, then goes back to working", async () => {
  const main = gw.sup.main();
  const job = gw.sup.createJob(main.id, "Rename photos", "/ask");
  await until(() => gw.sup.listThreads().find((t) => t.id === job.id)?.status === "needs_you");
  assert.ok(gw.sup.eventsAfter(main.id).some((e) => e.type === "aelvyril_job_update" && e.data.jobId === job.id && e.data.state === "needs_you"));
  const ok = await call(`/api/threads/${job.id}/ui-response`, { method: "POST", json: { id: "ui-1", confirmed: true } });
  assert.equal(ok.status, 200);
  await until(() => gw.sup.eventsAfter(main.id).some((e) => e.type === "aelvyril_job_update" && e.data.jobId === job.id && e.data.state === "working"));
});

test("a job whose process dies is marked failed and the main conversation hears about it", async () => {
  const main = gw.sup.main();
  const job = gw.sup.createJob(main.id, "Crashy", "/die");
  await until(() => gw.sup.getThread(job.id)?.state === "failed");
  assert.ok(gw.sup.eventsAfter(main.id).some((e) => e.type === "aelvyril_job_update" && e.data.jobId === job.id && e.data.state === "failed"));
});

test("only our own pi children may start jobs, and only from the main conversation", async () => {
  const main = gw.sup.main();
  const body = JSON.stringify({ threadId: main.id, title: "From the tool", task: "hello" });
  const post = (token?: string, b = body) => gw.app.request("/internal/jobs", { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-aelvyril-token": token } : {}) }, body: b });
  assert.equal((await post()).status, 403);
  assert.equal((await post("wrong")).status, 403);
  const ok = await post(gw.sup.internalToken);
  assert.equal(ok.status, 201);
  const { jobId } = await ok.json();
  assert.equal(gw.sup.getThread(jobId)?.parent_id, main.id);
  const chat = gw.sup.createThread();
  assert.equal((await post(gw.sup.internalToken, JSON.stringify({ threadId: chat.id, title: "x", task: "y" }))).status, 400);
  assert.equal((await post(gw.sup.internalToken, JSON.stringify({ threadId: main.id, title: "x", task: "  " }))).status, 400);
});

test("the Stream loads only the newest events when asked", async () => {
  const main = gw.sup.main();
  const all = gw.sup.eventsAfter(main.id);
  assert.ok(all.length > 5);
  const tail = gw.sup.eventsTail(main.id, 3);
  assert.deepEqual(tail.map((e) => e.seq), all.slice(-3).map((e) => e.seq));
  const sse = await call(`/api/threads/${main.id}/events?tail=2`);
  const reader = sse.body!.getReader();
  let text = "";
  while ((text.match(/^id: /gm) ?? []).length < 2) text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.equal((text.match(/^id: /gm) ?? []).length, 2);
});

const stateOf = (id: string) => gw.sup.getThread(id)!;
const cardStates = (parent: string, jobId: string) => gw.sup.eventsAfter(parent).filter((e) => e.type === "aelvyril_job_update" && e.data.jobId === jobId).map((e) => e.data.state);

test("finish contract: a task that declares done is done, with its own summary (not its chatter)", async () => {
  const main = gw.sup.main();
  const job = gw.sup.createJob(main.id, "Declared done", "/outcome-done All 12 photos are renamed in the Photos folder");
  await until(() => stateOf(job.id).state === "done");
  assert.equal(stateOf(job.id).preview, "All 12 photos are renamed in the Photos folder");
  assert.ok(cardStates(main.id, job.id).includes("done"));
  await until(() => gw.sup.eventsAfter(main.id).some((e) => e.type === "message_end" && e.data.message.role === "user" && String(e.data.message.content).includes("Declared done") && String(e.data.message.content).includes("12 photos")));
});

test("finish contract: need_input shows as needs-you with the question, then work resumes when the person answers", async () => {
  const main = gw.sup.main();
  const job = gw.sup.createJob(main.id, "Asks first", "/outcome-need Which folder should I use?");
  await until(() => stateOf(job.id).state === "needs_input");
  assert.equal(stateOf(job.id).preview, "Which folder should I use?");
  assert.equal(gw.sup.listThreads().find((t) => t.id === job.id)?.status, "needs_you");
  assert.ok(cardStates(main.id, job.id).includes("needs_you"));
  await until(() => gw.sup.eventsAfter(main.id).some((e) => e.type === "message_end" && e.data.message.role === "user" && String(e.data.message.content).includes("needs an answer")));
  // the person answers inside the task: it is working again, and its final result is reported again
  await gw.sup.prompt(job.id, "/outcome-done Used the Photos folder");
  await until(() => stateOf(job.id).state === "done");
  assert.equal(stateOf(job.id).preview, "Used the Photos folder");
  await until(() => gw.sup.eventsAfter(main.id).some((e) => e.type === "message_end" && e.data.message.role === "user" && String(e.data.message.content).includes("Used the Photos folder")));
});

test("finish contract: cannot_finish and incomplete are failures with an honest reason, never 'done'", async () => {
  const main = gw.sup.main();
  const a = gw.sup.createJob(main.id, "Cannot", "/outcome-cannot there is no network");
  const b = gw.sup.createJob(main.id, "Gave up", "/outcome-incomplete");
  await until(() => stateOf(a.id).state === "failed" && stateOf(b.id).state === "failed");
  assert.equal(stateOf(a.id).preview, "Couldn't finish: there is no network");
  assert.equal(stateOf(b.id).preview, "It stopped before it was finished.");
  assert.ok(cardStates(main.id, a.id).includes("failed"));
});

test("watchdog: a task that goes silent is stopped and marked failed; an idle or waiting one is left alone", async () => {
  const main = gw.sup.main();
  const stalled = gw.sup.createJob(main.id, "Stalls", "/stall");
  const waiting = gw.sup.createJob(main.id, "Waits for a yes", "/ask");
  await until(() => gw.sup.listThreads().find((t) => t.id === waiting.id)?.status === "needs_you");
  await until(() => gw.sup.listThreads().find((t) => t.id === stalled.id)?.running === true);
  const t = Date.now();
  gw.sup.checkTasks(t + gw.cfg.taskStallMs - 1000);
  assert.equal(stateOf(stalled.id).state, "working", "not yet");
  gw.sup.checkTasks(t + gw.cfg.taskStallMs + 5000);
  assert.equal(stateOf(stalled.id).state, "failed");
  assert.equal(stateOf(stalled.id).preview, "Couldn't finish: it stopped responding");
  assert.equal(stateOf(waiting.id).state, "working", "a task waiting for the person is never stopped for silence");
  assert.ok(cardStates(main.id, stalled.id).includes("failed"));
  await gw.sup.abort(waiting.id);
});

test("watchdog: a task that runs past the total limit is stopped", async () => {
  const main = gw.sup.main();
  const job = gw.sup.createJob(main.id, "Runs forever", "/stall");
  await until(() => gw.sup.listThreads().find((t) => t.id === job.id)?.running === true);
  const later = Date.now() + gw.cfg.taskMaxMs + 1000;
  // keep it "active" so only the total limit can be the reason
  (gw.sup as any).lastActivity.set(job.id, later);
  gw.sup.checkTasks(later);
  assert.equal(stateOf(job.id).preview, "Couldn't finish: it was taking too long");
});

test("restart: a working task is resumed from its saved session, at most twice, and otherwise failed", async () => {
  const main = gw.sup.main();
  const db = (gw.sup as any).db;
  const t = Date.now();
  const session = join(dir, "saved-session.jsonl");
  (await import("node:fs")).writeFileSync(session, "{}\n");
  const add = (id: string, file: string | null, resumes: number) => db.prepare("INSERT INTO threads (id,title,created_at,updated_at,kind,parent_id,state,session_file,resumes) VALUES (?,?,?,?, 'job', ?, 'working', ?, ?)").run(id, id, t, t, main.id, file, resumes);
  add("resume-ok", session, 0);
  add("resume-nofile", null, 0);
  add("resume-toomany", session, 2);
  gw.sup.recoverJobs();
  assert.equal(stateOf("resume-nofile").state, "failed");
  assert.equal(stateOf("resume-toomany").state, "failed");
  assert.equal(stateOf("resume-ok").state, "working");
  assert.equal(db.prepare("SELECT resumes FROM threads WHERE id='resume-ok'").get().resumes, 1);
  await until(() => gw.sup.eventsAfter("resume-ok").some((e) => e.type === "message_end" && e.data.message.role === "user" && String(e.data.message.content).includes("restarted")));
  await until(() => stateOf("resume-ok").state === "done");
});

test("retry: a failed or stopped task can be tried again, and says why it is trying again; a finished one cannot", async () => {
  const main = gw.sup.main();
  const job = gw.sup.createJob(main.id, "Flaky", "/outcome-cannot the site was down");
  await until(() => stateOf(job.id).state === "failed");
  const ok = await call(`/api/threads/${job.id}/retry`, { method: "POST" });
  assert.equal(ok.status, 200, await ok.clone().text());
  await until(() => stateOf(job.id).state === "done");
  assert.equal(stateOf(job.id).preview, "retried ok");
  const sent = gw.sup.eventsAfter(job.id).find((e) => e.type === "message_end" && e.data.message.role === "user" && String(e.data.message.content).startsWith("[aelvyril:retry]"));
  assert.ok(String(sent?.data.message.content).includes("the site was down"), "the retry message carries the reason it failed");
  const states = cardStates(main.id, job.id);
  assert.ok(states.includes("failed") && states.includes("working") && states.at(-1) === "done", states.join(","));
  assert.equal((await call(`/api/threads/${job.id}/retry`, { method: "POST" })).status, 400, "a finished task cannot be retried");
  assert.equal((await call(`/api/threads/nope/retry`, { method: "POST" })).status, 400);
  assert.equal((await gw.app.request(`/api/threads/${job.id}/retry`, { method: "POST" })).status, 401);
});
