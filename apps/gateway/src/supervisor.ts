import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { PiHost } from "./pi-host.ts";

type Json = Record<string, any>;

export type Kind = "main" | "job" | "chat";
export type Status = "needs_you" | "working" | "done" | "failed" | "stopped";

export interface Thread {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  kind: Kind;
  parent_id: string | null;
  /** Jobs only: working | done | failed | stopped. */
  state: string | null;
  /** One line from the latest assistant message, for list and card views. */
  preview: string;
}
export type ListedThread = Thread & { running: boolean; waiting: number; status: Status };

const COLS = "id,title,created_at,updated_at,kind,parent_id,state,preview";
export interface StoredEvent {
  /** 0 = live only (streaming deltas): never stored, never replayed. */
  seq: number;
  type: string;
  data: Json;
}

const DIALOGS = new Set(["select", "confirm", "input", "editor"]);
const LIVE_ONLY = new Set(["message_update", "tool_execution_update", "bash_execution_update"]);
const DEFAULT_TITLE = "New thread";
const MAIN_TITLE = "Stream";
/** First line of the message that hands a finished job's result to the main conversation; the web app hides it. */
export const JOB_MARKER = "[aelvyril:job-result]";
const MAIN_PROMPT =
  "You are Aelvyril, a friendly assistant for people who are not technical. " +
  "Answer questions directly and briefly in plain language. " +
  "You cannot read or change files or run commands in this conversation. " +
  "When a request needs that, or needs several steps or research, call the start_job tool with a clear, self-contained task, " +
  "then say in one sentence that you started it and are ready for the next question. " +
  "When you receive a message starting with " + JOB_MARKER + ", a job has finished: tell the user the outcome in a short, friendly message.";
/** What every background task is told (the task-guard extension enforces it). */
const JOB_PROMPT =
  "You are completing a background task for someone who is not technical. Do the whole task, check your own work, " +
  "and then finish by calling the finish_task tool exactly once: outcome \"done\" with a short plain-language summary of what you did and where the result is, " +
  "and \"verified\": what you ran or looked at to check it and what it showed. Anything you change must be checked afterwards: run the tests if there are any, otherwise look at the real result. " +
  "A \"done\" without that check is refused. Or outcome \"need_input\" with the one question you need answered (only when you truly cannot continue without the person); " +
  "or \"cannot_finish\" with the honest reason. Never end your turn without calling finish_task, and never claim success you have not checked.";
const RESUME_MESSAGE =
  "The program restarted while you were working on this task. Look at what you already did, continue from there without repeating finished steps, " +
  "and finish by calling finish_task.";
const MAX_RESUMES = 2;
/** A message the gateway writes into a task's conversation; the web app shows it as a short notice, not as the person's words. */
export const RETRY_MARKER = "[aelvyril:retry]";
/** The main conversation only talks and delegates; jobs do the work. */
const MAIN_EXCLUDED_TOOLS = "bash,edit,write,powershell,codemode,subagent";

/**
 * Owns the pi children (one per thread) and the event log.
 * The log (SQLite) is the source of truth the web app rebuilds from: panels,
 * pending dialogs and transcripts all derive from it, so a reload loses nothing.
 */
export class Supervisor {
  readonly bus = new EventEmitter();
  private hosts = new Map<string, PiHost>();
  private running = new Set<string>();
  private pendingUi = new Map<string, Set<string>>();
  private control: PiHost | null = null;
  private closed = false;
  /** Threads whose pi child must restart (config changed) once its current turn ends. */
  private stale = new Set<string>();

  /** Proves a request to /internal/* comes from one of our own pi children. New on every start. */
  readonly internalToken = randomBytes(24).toString("hex");
  /** Jobs whose outcome already went back to the main conversation (reset when the person writes to the task again). */
  private reported = new Set<string>();
  /** The outcome a task declared through finish_task, until the turn settles. */
  private outcomes = new Map<string, { outcome: string; summary: string; verified: string }>();
  private lastActivity = new Map<string, number>();
  private startedAt = new Map<string, number>();
  private watchdog: NodeJS.Timeout | null = null;

  private db: Db;
  private cfg: Config;

  constructor(db: Db, cfg: Config) {
    this.db = db;
    this.cfg = cfg;
    this.bus.setMaxListeners(0);
    this.watchdog = setInterval(() => this.checkTasks(), cfg.watchdogMs);
    this.watchdog.unref();
  }

  /**
   * Called once when the gateway starts: a task that was working when it stopped is resumed from its saved
   * session (at most MAX_RESUMES times, so a task that crashes the program cannot loop forever).
   */
  recoverJobs() {
    const rows = this.db.prepare("SELECT id, session_file, resumes FROM threads WHERE kind='job' AND state='working'").all() as { id: string; session_file: string | null; resumes: number }[];
    for (const r of rows) {
      if (r.session_file && existsSync(r.session_file) && r.resumes < MAX_RESUMES) {
        this.db.prepare("UPDATE threads SET resumes=resumes+1 WHERE id=?").run(r.id);
        this.prompt(r.id, RESUME_MESSAGE).catch((e: Error) => this.finishJob(r.id, "failed", e.message));
      } else {
        this.finishJob(r.id, "failed", "the program restarted and this task could not be resumed");
      }
    }
  }

  /** Stops tasks that went silent or ran too long, and says so honestly. Runs on a timer. */
  checkTasks(now = Date.now()) {
    if (this.closed) return;
    const rows = this.db.prepare("SELECT id FROM threads WHERE kind='job' AND state='working'").all() as { id: string }[];
    for (const { id } of rows) {
      if (!this.running.has(id) || (this.pendingUi.get(id)?.size ?? 0) > 0) continue; // idle, or waiting for the person
      const quiet = now - (this.lastActivity.get(id) ?? now);
      const total = now - (this.startedAt.get(id) ?? now);
      const why = quiet > this.cfg.taskStallMs ? "it stopped responding" : total > this.cfg.taskMaxMs ? "it was taking too long" : "";
      if (why) this.stopAndFail(id, why);
    }
  }

  private stopAndFail(id: string, why: string) {
    const host = this.hosts.get(id);
    this.hosts.delete(id);
    this.running.delete(id);
    this.finishJob(id, "failed", why);
    host?.kill();
  }

  // ---- threads -----------------------------------------------------------
  listThreads(): ListedThread[] {
    const rows = this.db.prepare(`SELECT ${COLS} FROM threads ORDER BY updated_at DESC`).all() as Thread[];
    return rows.map((t) => {
      const waiting = this.pendingUi.get(t.id)?.size ?? 0;
      const running = this.running.has(t.id);
      const status: Status = waiting > 0 || t.state === "needs_input" ? "needs_you" : t.kind === "job" ? ((t.state ?? "done") as Status) : running ? "working" : "done";
      return { ...t, running, waiting, status };
    });
  }

  getThread(id: string): Thread | undefined {
    return this.db.prepare(`SELECT ${COLS} FROM threads WHERE id=?`).get(id) as Thread | undefined;
  }

  /** The one permanent conversation behind the Stream; created the first time it is asked for. */
  main(): Thread {
    const row = this.db.prepare(`SELECT ${COLS} FROM threads WHERE kind='main' LIMIT 1`).get() as Thread | undefined;
    if (row) return row;
    const now = Date.now();
    const id = randomUUID();
    this.db.prepare("INSERT INTO threads (id,title,created_at,updated_at,kind) VALUES (?,?,?,?, 'main')").run(id, MAIN_TITLE, now, now);
    return this.getThread(id)!;
  }

  /** Starts a background job for the main conversation. Returns at once; the job runs on its own. */
  createJob(parentId: string, title: string, task: string): Thread {
    const parent = this.getThread(parentId);
    if (!parent || parent.kind !== "main") throw new Error("jobs can only be started from the main conversation");
    const name = title.replace(/\s+/g, " ").trim().slice(0, 80) || "Job";
    if (!task.trim() || task.length > 50_000) throw new Error("the job needs a task (up to 50,000 characters)");
    const now = Date.now();
    const id = randomUUID();
    this.db.prepare("INSERT INTO threads (id,title,created_at,updated_at,kind,parent_id,state) VALUES (?,?,?,?, 'job', ?, 'working')").run(id, name, now, now, parentId);
    this.append(parentId, { type: "aelvyril_job_started", jobId: id, title: name });
    this.startedAt.set(id, now);
    this.lastActivity.set(id, now);
    this.prompt(id, task).catch((e: Error) => this.finishJob(id, "failed", e.message));
    return this.getThread(id)!;
  }

  /**
   * A task's turn ended (or it failed). Decide the honest state from what it declared through finish_task:
   * done / need_input / cannot_finish, or "incomplete" when the guard gave up. No declaration at all (the guard
   * extension missing) keeps the old behaviour: done.
   */
  private finishJob(jobId: string, state: "done" | "failed" | "stopped", detail?: string) {
    if (this.closed) return;
    const job = this.getThread(jobId);
    if (!job || job.kind !== "job") return;
    if (state === "failed" && job.state === "failed") return; // already reported (e.g. watchdog, then the process exit)
    const declared = this.outcomes.get(jobId);
    this.outcomes.delete(jobId);
    let final: string = state;
    let text = job.preview;
    if (state === "done" && declared) {
      if (declared.outcome === "need_input") [final, text] = ["needs_input", declared.summary];
      else if (declared.outcome === "cannot_finish") [final, text] = ["failed", `Couldn't finish: ${declared.summary}`];
      else if (declared.outcome === "incomplete") [final, text] = ["failed", "It stopped before it was finished."];
      else [final, text] = ["done", declared.summary || job.preview];
    } else if (state === "failed") text = detail ? `Couldn't finish: ${detail}` : "Couldn't finish.";
    this.settleJob(jobId, final, text, declared?.summary, declared?.verified);
  }

  /** Records the final state, updates the card, and tells the main conversation once. */
  private settleJob(jobId: string, final: string, text: string, summary: string | undefined, verified?: string) {
    if (this.closed) return;
    const job = this.getThread(jobId);
    if (!job) return;
    this.db.prepare("UPDATE threads SET state=?, preview=? WHERE id=?").run(final, text.slice(0, 160), jobId);
    const parent = job.parent_id;
    if (!parent || !this.getThread(parent)) return;
    const cardState = final === "needs_input" ? "needs_you" : final;
    this.append(parent, { type: "aelvyril_job_update", jobId, title: job.title, state: cardState, preview: text.slice(0, 160) });
    if (final !== "stopped" && !this.reported.has(jobId)) {
      this.reported.add(jobId);
      const body = (final === "done" ? (summary || this.lastAssistantText(jobId) || text) : text) + (final === "done" && verified ? `\n\nHow it was checked: ${verified}` : "");
      const what = final === "done" ? "has finished. Its result" : final === "needs_input" ? "needs an answer from the user before it can continue. Its question" : "could not be finished. What happened";
      this.prompt(parent, `${JOB_MARKER}\nThe task "${job.title}" ${what}:\n\n${body.slice(0, 6000)}`).catch(() => {});
    }
  }

  /** "Try again" for a task that failed or was stopped: back to work, told why the last attempt did not work out. */
  async retry(jobId: string) {
    const t = this.getThread(jobId);
    if (!t || t.kind !== "job" || (t.state !== "failed" && t.state !== "stopped")) throw new Error("only a task that did not finish can be tried again");
    const why = t.preview;
    await this.prompt(jobId, `${RETRY_MARKER}\nThe person asked you to try again. Last time: ${why}\nTry again. Take a different approach if the first one did not work, check your work, and finish by calling finish_task.`);
    this.db.prepare("UPDATE threads SET preview=? WHERE id=?").run("Trying again…", jobId);
    this.tellParent(jobId, "working");
  }

  private lastAssistantText(threadId: string): string {
    const rows = this.db.prepare("SELECT data FROM events WHERE thread_id=? AND type='message_end' ORDER BY seq DESC LIMIT 20").all(threadId) as { data: string }[];
    for (const r of rows) {
      const m = JSON.parse(r.data).message;
      if (m?.role !== "assistant") continue;
      const t = (Array.isArray(m.content) ? m.content : []).map((b: Json) => (b?.type === "text" ? b.text : "")).join("");
      if (t.trim()) return t.trim();
    }
    return "";
  }

  createThread(title = DEFAULT_TITLE): Thread {
    const now = Date.now();
    const id = randomUUID();
    this.db.prepare("INSERT INTO threads (id,title,created_at,updated_at) VALUES (?,?,?,?)").run(id, title, now, now);
    return this.getThread(id)!;
  }

  renameThread(id: string, title: string) {
    this.db.prepare("UPDATE threads SET title=? WHERE id=?").run(title.slice(0, 120), id);
  }

  deleteThread(id: string) {
    this.hosts.get(id)?.kill();
    this.hosts.delete(id);
    this.running.delete(id);
    this.pendingUi.delete(id);
    this.db.prepare("DELETE FROM events WHERE thread_id=?").run(id);
    this.db.prepare("DELETE FROM threads WHERE id=?").run(id);
  }

  // ---- event log ---------------------------------------------------------
  append(threadId: string, data: Json): StoredEvent {
    const type = String(data.type ?? "unknown");
    if (this.closed) return { seq: 0, type, data };
    if (LIVE_ONLY.has(type)) {
      const ev = { seq: 0, type, data };
      this.bus.emit(threadId, ev);
      return ev;
    }
    const row = this.db
      .prepare("INSERT INTO events (thread_id,seq,type,data) VALUES (?, COALESCE((SELECT MAX(seq) FROM events WHERE thread_id=?),0)+1, ?, ?) RETURNING seq")
      .get(threadId, threadId, type, JSON.stringify(data)) as { seq: number };
    this.db.prepare("UPDATE threads SET updated_at=? WHERE id=?").run(Date.now(), threadId);
    const ev = { seq: row.seq, type, data };
    this.bus.emit(threadId, ev);
    return ev;
  }

  /** The newest results a task has put on screen: one per panel id (a later panel with the same id replaces an earlier one), newest first. */
  panelsOf(threadId: string, max = 3): Json[] {
    const rows = this.db.prepare("SELECT data FROM events WHERE thread_id=? AND type='entry_appended' ORDER BY seq DESC LIMIT 300").all(threadId) as { data: string }[];
    const seen = new Set<string>();
    const out: Json[] = [];
    for (const r of rows) {
      const en = JSON.parse(r.data).entry;
      if (en?.type !== "custom" || en.customType !== "aelvyril.panel" || typeof en.data?.id !== "string" || seen.has(en.data.id)) continue;
      seen.add(en.data.id);
      out.push(en.data);
      if (out.length >= max) break;
    }
    return out;
  }

  private lastUserText(threadId: string): string {
    const rows = this.db.prepare("SELECT data FROM events WHERE thread_id=? AND type='message_end' ORDER BY seq DESC LIMIT 40").all(threadId) as { data: string }[];
    for (const r of rows) {
      const m = JSON.parse(r.data).message;
      if (m?.role !== "user") continue;
      const t = typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content : []).map((b: Json) => (b?.type === "text" ? b.text : "")).join("");
      if (t.trim() && !t.startsWith(JOB_MARKER)) return t.trim();
    }
    return "";
  }

  /** What the Board shows: the Stream's latest exchange, and every task with its newest results. */
  board() {
    const main = this.main();
    return {
      main: { id: main.id, lastUser: this.lastUserText(main.id).slice(0, 300), lastAssistant: this.lastAssistantText(main.id).slice(0, 600) },
      tasks: this.listThreads()
        .filter((t) => t.kind === "job")
        .map((t) => ({ id: t.id, title: t.title, status: t.status, preview: t.preview, updated_at: t.updated_at, running: t.running, panels: this.panelsOf(t.id) })),
    };
  }

  /** The newest `n` stored events, oldest first. The Stream is endless, so the browser loads the tail, not everything. */
  eventsTail(threadId: string, n: number): StoredEvent[] {
    const rows = this.db.prepare("SELECT seq,type,data FROM events WHERE thread_id=? ORDER BY seq DESC LIMIT ?").all(threadId, n) as {
      seq: number;
      type: string;
      data: string;
    }[];
    return rows.reverse().map((r) => ({ seq: r.seq, type: r.type, data: JSON.parse(r.data) }));
  }

  eventsAfter(threadId: string, after = 0): StoredEvent[] {
    const rows = this.db.prepare("SELECT seq,type,data FROM events WHERE thread_id=? AND seq>? ORDER BY seq").all(threadId, after) as {
      seq: number;
      type: string;
      data: string;
    }[];
    return rows.map((r) => ({ seq: r.seq, type: r.type, data: JSON.parse(r.data) }));
  }

  // ---- pi hosts ----------------------------------------------------------
  private spawn(cwd: string, extra: string[], onEvent: (e: Json) => void, onExit: (c: number | null) => void, env: Record<string, string> = {}): PiHost {
    mkdirSync(cwd, { recursive: true });
    return new PiHost({
      command: this.cfg.piCommand,
      args: [...this.cfg.piArgs, "--mode", "rpc", ...extra],
      cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: this.cfg.piHome, ...env },
      onEvent,
      onExit,
    });
  }

  ensureHost(threadId: string): PiHost {
    const existing = this.hosts.get(threadId);
    if (existing && !existing.exited) return existing;
    const row = this.db.prepare("SELECT session_file, kind FROM threads WHERE id=?").get(threadId) as { session_file: string | null; kind: Kind } | undefined;
    const session = row?.session_file && existsSync(row.session_file) ? ["--session", row.session_file] : [];
    const isMain = row?.kind === "main";
    const isJob = row?.kind === "job";
    const host: PiHost = this.spawn(
      join(this.cfg.workspacesDir, threadId),
      [
        ...session,
        // The main conversation talks and delegates: it gets start_job and no file/shell tools.
        ...(isMain ? ["-e", this.cfg.jobsExtension, "--append-system-prompt", MAIN_PROMPT, "--exclude-tools", MAIN_EXCLUDED_TOOLS] : []),
        // A task gets the finish contract: finish_task, a self-check, and nudges until it declares an outcome.
        ...(isJob ? ["-e", this.cfg.taskGuardExtension, "--append-system-prompt", JOB_PROMPT] : []),
      ],
      (e) => this.onPiEvent(threadId, e),
      (code) => {
        const wasRunning = this.running.has(threadId);
        if (this.hosts.get(threadId) === host) this.hosts.delete(threadId);
        this.running.delete(threadId);
        this.pendingUi.delete(threadId);
        if (!this.closed && this.getThread(threadId)) this.append(threadId, { type: "aelvyril_host_exit", code });
        // A job whose process died mid-run can never finish.
        if (!this.closed && wasRunning && this.getThread(threadId)?.kind === "job" && this.getThread(threadId)?.state === "working") this.finishJob(threadId, "failed", "the helper stopped unexpectedly");
      },
      { AELVYRIL_INTERNAL_URL: `http://127.0.0.1:${this.cfg.port}`, AELVYRIL_INTERNAL_TOKEN: this.internalToken, AELVYRIL_THREAD_ID: threadId },
    );
    this.hosts.set(threadId, host);
    this.append(threadId, { type: "aelvyril_host_start" });
    if (!session.length) {
      host
        .call({ type: "get_state" })
        .then((r) => {
          const f = r.data?.sessionFile;
          if (f && !this.closed) this.db.prepare("UPDATE threads SET session_file=? WHERE id=?").run(f, threadId);
        })
        .catch(() => {});
    }
    return host;
  }

  private onPiEvent(threadId: string, e: Json) {
    this.lastActivity.set(threadId, Date.now());
    if (e.type === "agent_start") this.running.add(threadId);
    if (e.type === "entry_appended" && e.entry?.customType === "aelvyril.task_outcome" && e.entry.data?.outcome) {
      this.outcomes.set(threadId, { outcome: String(e.entry.data.outcome), summary: String(e.entry.data.summary ?? ""), verified: String(e.entry.data.verified ?? "") });
    }
    if (e.type === "message_end" && e.message?.role === "assistant") {
      const text = (Array.isArray(e.message.content) ? e.message.content : []).map((b: Json) => (b?.type === "text" ? b.text : "")).join("").replace(/\s+/g, " ").trim();
      if (text && !this.closed) this.db.prepare("UPDATE threads SET preview=? WHERE id=?").run(text.slice(0, 160), threadId);
    }
    if (e.type === "extension_ui_request" && DIALOGS.has(e.method)) {
      const set = this.pendingUi.get(threadId) ?? new Set();
      set.add(e.id);
      this.pendingUi.set(threadId, set);
      this.tellParent(threadId, "needs_you");
    }
    if (!this.closed && this.getThread(threadId)) this.append(threadId, e);
    if (e.type === "agent_settled") {
      this.running.delete(threadId);
      if (this.stale.delete(threadId)) this.hosts.get(threadId)?.kill();
      if (this.getThread(threadId)?.kind === "job") this.finishJob(threadId, e.aborted ? "stopped" : "done");
    }
  }

  /** Keeps the job's card in the main conversation current (a job waiting on a dialog shows as "needs you"). */
  private tellParent(jobId: string, state: string) {
    if (this.closed) return;
    const job = this.getThread(jobId);
    if (!job || job.kind !== "job" || !job.parent_id || !this.getThread(job.parent_id)) return;
    this.append(job.parent_id, { type: "aelvyril_job_update", jobId, title: job.title, state, preview: job.preview });
  }

  async prompt(threadId: string, message: string) {
    if (this.closed) throw new Error("shutting down");
    const t = this.getThread(threadId);
    if (!t) throw new Error("no such thread");
    if (t.kind === "chat" && t.title === DEFAULT_TITLE) this.renameThread(threadId, message.replace(/\s+/g, " ").trim().slice(0, 60) || DEFAULT_TITLE);
    // Talking to a finished job again puts it back to work.
    if (t.kind === "job") {
      if (t.state !== "working") this.db.prepare("UPDATE threads SET state='working' WHERE id=?").run(threadId);
      this.outcomes.delete(threadId);
      this.reported.delete(threadId); // a new round: its outcome is reported again
      this.lastActivity.set(threadId, Date.now());
      if (t.state !== "working" || !this.startedAt.has(threadId)) this.startedAt.set(threadId, Date.now());
    }
    const host = this.ensureHost(threadId);
    const r = await host.call({ type: "prompt", message, ...(this.running.has(threadId) ? { streamingBehavior: "steer" } : {}) });
    if (!r.success) throw new Error(r.error ?? "prompt rejected");
    return r.data;
  }

  async abort(threadId: string) {
    const host = this.hosts.get(threadId);
    if (!host) return;
    for (const id of [...(this.pendingUi.get(threadId) ?? [])]) this.resolveUi(threadId, { id, cancelled: true });
    await host.call({ type: "abort" }).catch(() => {});
  }

  /** Answers a dialog the extension is waiting on. */
  resolveUi(threadId: string, body: { id: string; value?: unknown; confirmed?: boolean; cancelled?: boolean }) {
    const set = this.pendingUi.get(threadId);
    const host = this.hosts.get(threadId);
    if (!set?.has(body.id) || !host) return false;
    host.send({ type: "extension_ui_response", ...body });
    set.delete(body.id);
    this.append(threadId, { type: "aelvyril_ui_resolved", id: body.id });
    if (set.size === 0) this.tellParent(threadId, "working");
    return true;
  }

  async setModel(threadId: string, provider: string, modelId: string) {
    const r = await this.ensureHost(threadId).call({ type: "set_model", provider, modelId });
    if (!r.success) throw new Error(r.error ?? "set_model failed");
    return r.data;
  }

  // ---- models (a control host with no session) ---------------------------
  private controlHost(): PiHost {
    if (this.control && !this.control.exited) return this.control;
    const host: PiHost = this.spawn(
      join(this.cfg.workspacesDir, "_control"),
      ["--no-session"],
      () => {},
      () => {
        if (this.control === host) this.control = null;
      },
    );
    return (this.control = host);
  }

  /** How long the model-list helper may stay silent before it is replaced (a restart right after a config change can hang it). */
  controlTimeoutMs = 15_000;

  /**
   * `expectSome`: a provider is connected, so an empty list means pi has not finished working out
   * which models are available yet (it does that right after starting). Ask again for a few seconds.
   * A helper that errors or goes silent is killed and replaced, then we ask again.
   */
  async models(expectSome = false): Promise<Json[]> {
    let last: Json[] = [];
    let failure: unknown;
    for (let attempt = 0; attempt < (expectSome ? 12 : 3); attempt++) {
      try {
        const r = await this.controlHost().call({ type: "get_available_models" }, this.controlTimeoutMs);
        failure = undefined;
        last = r.data?.models ?? [];
        if (last.length || !expectSome) return last;
      } catch (e) {
        failure = e;
        const dead = this.control;
        this.control = null;
        dead?.kill();
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (failure) throw failure;
    return last;
  }

  /**
   * pi has no reload over RPC: after models.json / auth.json / settings change, children must restart.
   * Idle ones restart now; a child in the middle of a turn finishes it first.
   */
  configChanged() {
    // Forget killed children at once, so the very next request starts a fresh one instead of hitting a dying process.
    const control = this.control;
    this.control = null;
    control?.kill();
    for (const [id, h] of [...this.hosts]) {
      if (this.running.has(id)) this.stale.add(id);
      else {
        this.hosts.delete(id);
        h.kill();
      }
    }
  }

  shutdown() {
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.control?.kill();
    for (const h of this.hosts.values()) h.kill();
  }
}
