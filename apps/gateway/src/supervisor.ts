import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { EventEnvelope, PatchSpecBody } from "@aelvyril/shared";
import { RpcClient, type RpcEvent } from "./rpc.js";
import type { EventBus } from "./bus.js";
import type { Store } from "./store.js";
import { AgentContract, buildVerifyRetryPrompt, type ContractEnvelope, type SpecMode } from "./agent-contract.js";
import { classifyAction, type Autonomy } from "./risk.js";
import { formatFailure, resolveVerifyCommands, runVerification, type VerifyExec } from "./verify.js";
import { computeWorkspaceDiff, type FilePatch } from "./workspace-git.js";

/**
 * Dogfood 2026-10-09: a real pi never emits top-level custom_spec_* protocol
 * events — that shape is a fake-pi fixture convenience. A real model follows
 * SPEC_PROTOCOL_INSTRUCTIONS and prints the signal JSON inside its assistant
 * TEXT, where it used to be lost (the spec interview, draft registration,
 * and auto-run never fired against a live host). Scan assistant text for
 * those JSON objects and feed them to the contract exactly like the
 * scripted protocol lines.
 */
export function extractSpecSignals(
  text: string,
): Array<{ type: string } & Record<string, unknown>> {
  const out: Array<{ type: string } & Record<string, unknown>> = [];
  // Bound the scan: pathological messages must not turn into O(n²) parses.
  const window = text.length > 262_144 ? text.slice(0, 262_144) : text;
  const start = /\{\s*"type"\s*:\s*"custom_spec_(?:question|draft)"/g;
  for (const m of window.matchAll(start)) {
    // The JSON may be preceded and followed by prose, so the end is unknown:
    // try each closing brace as a candidate end until the slice parses.
    // Braces inside JSON strings can't complete a valid document, so this
    // is exact, not heuristic.
    for (let end = window.indexOf("}", m.index); end !== -1; end = window.indexOf("}", end + 1)) {
      try {
        const parsed = JSON.parse(window.slice(m.index, end + 1)) as {
          type: string;
        } & Record<string, unknown>;
        if (typeof parsed.type === "string" && parsed.type.startsWith("custom_spec_")) out.push(parsed);
        break;
      } catch {
        continue;
      }
    }
  }
  return out;
}

/**
 * Review P2: with no workspace configured, session hosts must never spawn
 * inside the gateway's own repo tree (the old process.cwd() fallback). Each
 * thread gets a scratch dir under the OS temp dir instead. The id is
 * sanitized so a hostile id can't traverse out of the scratch root.
 */
function defaultScratchCwd(conversationId: string): string {
  const safeId = conversationId.replace(/[^A-Za-z0-9_-]/g, "_") || "anonymous";
  const dir = join(tmpdir(), "aelvyril-sessions", safeId);
  // Review P2, fail-closed: an unwritable temp dir must NOT silently fall
  // back to process.cwd() — that spawns (and writes!) inside the gateway's
  // own repo tree. Let the mkdir failure propagate: the prompt fails (the
  // routes turn it into 502 + degraded) instead of running in the wrong
  // place.
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface VerifyOptions {
  /** GATEWAY_VERIFY_COMMANDS override ("pnpm test,pnpm lint"). */
  commandsOverride?: string;
  timeoutMs?: number;
  /** #82: bounded self-retry budget. Default 3. */
  retries?: number;
  /** Test override for the command runner. */
  exec?: VerifyExec;
}

export interface SupervisorOptions {
  bus: EventBus;
  store: Store;
  /** extraEnv is merged over process.env by the caller at spawn time. */
  spawnChild: (
    conversationId: string,
    extraEnv: Record<string, string>,
    cwd?: string,
  ) => ChildProcess;
  idleMs: number;
  /** Metrics hooks (spec §11 observability). Both optional. */
  onSessionHostSpawn?: () => void;
  onSessionHostExit?: () => void;
  /** #84: per-thread budget. When the harvested cumulative cost reaches
   *  this many USD, the thread is marked blocked/capped and the next
   *  prompt is refused at the route. Undefined = no cap. */
  maxCostPerThreadUsd?: number;
  /** #84: how blocking pi extension_ui_request dialogs are handled.
   *  "auto-responder" (default) answers them cancelled so headless runs
   *  can't hang (spec §14.3); "blocked" escalates to the blocked state. */
  dialogMode?: "auto-responder" | "blocked";
  /** #77: grace period between the initial SIGTERM and the SIGKILL
   *  escalation when stopping a session host. Default 2_000ms (tests
   *  shrink it). */
  killGraceMs?: number;
  /** #81.2: bounded question budget per interview. Default 3 rounds. */
  specMaxRounds?: number;
  /** #81.3: merges-without-revision at which a namespace's autonomy
   *  escalates to "established" (external actions auto-run). Default 5;
   *  0 disables escalation. */
  trustThreshold?: number;
  /** Review: structured logger (pino-compatible subset). Contract reply
   *  failures are reported here at warn level so a dead stdin / rpc
   *  timeout on a fire-and-forget reply is observable. Optional. */
  logger?: { warn(obj: object, msg?: string, ...args: unknown[]): void };
  /** #82: auto-verify loop config. Null disables verification entirely. */
  verify?: VerifyOptions | null;
  /** #80: diff producer override for tests. Default runs real git. */
  computeDiff?: (cwd: string) => Promise<FilePatch[] | null>;
}

interface Handle {
  /** Identity of the thread this handle serves (event routing is
   *  handle-keyed so a zombie's events can be told apart from a live
   *  host's — review P1 rework). */
  conversationId: string;
  rpc: RpcClient;
  child: ChildProcess;
  lastActivity: number;
  exiting: boolean;
  /** #80: per-session contract — protocol translation + lifecycle. */
  contract: AgentContract;
  /** #82: verification attempts spent on the CURRENT user turn. */
  verifyAttempts: number;
  /** Review P2: bumped on every prompt()/prepareTurn so the async
   *  postTurnPipeline can detect a newer user turn and stand down. */
  turnGeneration: number;
  /** Review P1 rework: set when THIS child is killed via killChild —
   *  resolves (bounded) at the child's exit. Protocol events arriving
   *  from a handle with this set are dropped; a respawned host is a
   *  different handle and is never silenced. */
  zombie?: Promise<void>;
  /** Review SHOULD-FIX: set by escalateGate when the gate's abort is
   *  issued, consumed by the first settle the handle sees afterwards. The
   *  abort ends the gated turn with an agent_settled; when a newer user
   *  turn un-parks the thread (beginUserTurn clears gateStopped) BEFORE
   *  that settle arrives, this marker identifies it as the OLD turn's
   *  leftover so it is dropped instead of writing idle/harvest/pipeline
   *  over the live turn. */
  pendingAbortSettle: boolean;
}

/**
 * One RPC child process per conversation (spec D6). Normalizes protocol
 * events into EventEnvelopes, persists + fans out via the bus, and owns the
 * lifecycle: spawn-on-demand, idle reap, crash -> degraded (respawn on next
 * prompt from the pi session file in Phase 3).
 */
export class Supervisor {
  private handles = new Map<string, Handle>();
  private reaper: NodeJS.Timeout;
  /** Security review #85, reworked (review P1): children killed via
   *  killChild ("zombies"), per conversation. The old `dead` set was
   *  keyed by conversationId, so a RESPAWNED host's events were dropped
   *  until the OLD child exited (up to killGraceMs or forever). Zombies
   *  are now tracked by child identity (the resolving exit promise on
   *  the handle): handleProtocolEvent drops only zombie events, and
   *  prepareTurn awaits these before spawning a replacement. */
  private zombies = new Map<string, Promise<void>[]>();

  constructor(private opts: SupervisorOptions) {
    this.reaper = setInterval(() => this.reapIdle(), Math.min(opts.idleMs, 5_000));
    this.reaper.unref();
  }

  has(conversationId: string): boolean {
    return this.handles.has(conversationId);
  }

  /** #83: total live session hosts across all users — global ceiling. */
  runningCount(): number {
    return this.handles.size;
  }

  private ensureSession(conversationId: string, extraEnv: Record<string, string>, cwd?: string): Handle {
    const existing = this.handles.get(conversationId);
    if (existing) return existing;
    // Spec §6/§10: workspace -> spawn cwd so pi finds its prior session file
    // on disk after a crash + re-prompt. Caller-provided cwd wins (for tests
    // + future overrides); otherwise the supervisor reads workspace from the
    // store itself — the route doesn't need to plumb it through.
    // Review P2: with no workspace configured the child used to inherit the
    // gateway's own repo tree via process.cwd() — a session host must never
    // run (and write!) inside the gateway. Fall back to a per-thread scratch
    // dir under the OS temp dir instead.
    const configured = cwd ?? this.opts.store.getConversationById(conversationId)?.workspace ?? undefined;
    const spawnCwd = configured ?? defaultScratchCwd(conversationId);
    const child = this.opts.spawnChild(conversationId, extraEnv, spawnCwd);
    const rpc = new RpcClient(child);
    // #80: the contract is the protocol→envelope translator + lifecycle
    // owner for THIS session. Its io closures always resolve the CURRENT
    // handle, so replies keep working across a respawn.
    const contract = new AgentContract(
      {
        threadId: conversationId,
        reply: (message) => {
          const h = this.handles.get(conversationId);
          if (!h || h.exiting) return;
          try {
            this.opts.store.setConversationState(conversationId, "streaming");
            this.publish(conversationId, { kind: "session_state", payload: { state: "streaming" } });
          } catch {
            // store closed; the rpc send below still rejects safely
          }
          h.lastActivity = Date.now();
          // Review: reply failures (dead stdin, rpc timeout, busy-reject)
          // are no longer swallowed silently — the contract reports them to
          // the supervisor's logger at warn level when one is wired.
          void h.rpc.send({ type: "prompt", message }).catch((err) => {
            h.contract.reportReplyFailure(err);
          });
        },
        publish: (e: ContractEnvelope) => {
          try {
            this.opts.bus.publish(e);
          } catch {
            // store closed (shutdown); drop
          }
        },
        persistDraft: (draft) => {
          try {
            this.opts.store.setSpecDraftById(conversationId, draft);
          } catch {
            // store closed; drop
          }
        },
        autonomy: () => this.autonomyFor(conversationId),
      },
      {
        specMode: "auto",
        maxSpecRounds: this.opts.specMaxRounds,
        // Review: make fire-and-forget reply failures observable (warn).
        onReplyFailure: (err) => {
          try {
            this.opts.logger?.warn(
              { err: err instanceof Error ? err : String(err) },
              "agent contract reply failed to reach the session host",
            );
          } catch {
            // a broken logger must not break the reply path
          }
        },
      },
    );
    const handle: Handle = {
      conversationId,
      rpc,
      child,
      lastActivity: Date.now(),
      exiting: false,
      contract,
      verifyAttempts: 0,
      turnGeneration: 0,
      pendingAbortSettle: false,
    };
    // Event routing is bound to THIS handle: a zombie's in-flight events
    // carry the zombie handle, a live host's carry the live one (review P1).
    rpc.on("event", (ev: RpcEvent) => this.onProtocolEvent(handle, ev));
    rpc.on("exit", () => {
      // The host exited — the gauge reflects that regardless of whether the
      // exit was expected (kill/reap/dispose) or a crash.
      this.opts.onSessionHostExit?.();
      // Review P1 rework: the dead-mark is child-scoped (handle.zombie), so
      // nothing conversation-level needs lifting here — a respawned host is
      // a different handle whose events were never silenced.
      // #77: only the CURRENT handle's exit mutates map/state. A stale
      // child's late exit event must not delete a respawned host's handle
      // or publish a spurious degraded state for a live session.
      if (this.handles.get(conversationId) !== handle) return;
      // #77: reapIdle keeps an exiting host registered until THIS event
      // fires, so the delete happens here for the reap path (killChild
      // already deleted synchronously — a no-op for that path).
      this.handles.delete(conversationId);
      if (handle.exiting) return;
      // Best-effort: child may emit exit AFTER disposeAll closes the store
      // (test teardown race, or a real SIGTERM during shutdown). Silently
      // drop the event rather than crash the gateway — spec §10
      // ("backing service failures fail soft") covers this.
      try {
        this.opts.store.setConversationState(conversationId, "degraded");
        this.publish(conversationId, { kind: "session_state", payload: { state: "degraded" } });
      } catch {
        // store closed; ignore
      }
    });
    this.handles.set(conversationId, handle);
    this.opts.onSessionHostSpawn?.();
    return handle;
  }

  /**
   * Resolves as soon as the child ACCEPTS the prompt — 202 semantics per
   * spec §6 (clients stream the turn via SSE; a real pi turn can run for
   * minutes and must never block the HTTP call).
   */
  async prompt(
    conversationId: string,
    message: string,
    streamingBehavior?: "steer" | "followUp",
    extraEnv?: Record<string, string>,
    cwd?: string,
    /** #80 fix 2: specMode is no longer dropped at the route. */
    specMode: SpecMode = "auto",
  ): Promise<boolean> {
    const handle = await this.prepareTurn(conversationId, extraEnv, cwd);
    // New user turn: the verify retry budget resets (#82), and the
    // contract's per-turn state resets with it — gateStopped (a plain
    // re-prompt after a gate stop must settle normally instead of sticking
    // "streaming"), awaitingInterview, and specRounds (the question budget
    // is per-interview, not lifetime-of-handle).
    handle.verifyAttempts = 0;
    handle.contract.beginUserTurn();
    this.opts.store.setLastPromptById(conversationId, message);
    handle.contract.setTurnSpecMode(specMode);
    const command: Record<string, unknown> = {
      type: "prompt",
      message: handle.contract.wrapPrompt(message),
    };
    if (streamingBehavior) command.streamingBehavior = streamingBehavior;
    const res = await handle.rpc.send(command);
    return res.success;
  }

  /**
   * Shared turn preamble: wait out a dying host, ensure the session, flip
   * the conversation to streaming. Used by user prompts AND the lifecycle
   * routes (approve/retry must work with no live host — #80 fix 3).
   */
  private async prepareTurn(
    conversationId: string,
    extraEnv?: Record<string, string>,
    cwd?: string,
  ): Promise<Handle> {
    // Review P1: a killChild'ed host is awaited too — the same invariant as
    // the reap path below (never two pi processes on one session file), and
    // a replacement must not spawn while the zombie could still write.
    // Bounded by exitOf (kill grace + margin), so a stuck child cannot hang
    // the prompt forever.
    const pendingZombies = this.zombies.get(conversationId);
    if (pendingZombies?.length) await Promise.all(pendingZombies);
    // #77: an idle-reaped host keeps its handle until its exit fires. Wait
    // for it so this prompt is not written into a dying child's stdin and
    // does not double-spawn a second pi on the same session file while the
    // SIGTERMed original is still alive.
    const existing = this.handles.get(conversationId);
    if (existing?.exiting) await this.exitOf(existing);
    // extraEnv + cwd only apply at spawn time; a reused session keeps its env.
    const handle = this.ensureSession(conversationId, extraEnv ?? {}, cwd);
    // Review P2: a new turn invalidates any in-flight postTurnPipeline.
    handle.turnGeneration++;
    this.opts.store.setConversationState(conversationId, "streaming");
    this.publish(conversationId, { kind: "session_state", payload: { state: "streaming" } });
    handle.lastActivity = Date.now();
    return handle;
  }

  /**
   * #80 fix 3: approve sends the REAL execution prompt, rebuilt from the
   * persisted spec so it works even when the session host is gone (gateway
   * restart between spec'ing and approve). Also clears any gated actions
   * the user just reviewed.
   */
  async approveExecution(conversationId: string): Promise<boolean> {
    const spec = this.opts.store.getThreadSpecById(conversationId);
    const handle = await this.prepareTurn(conversationId, this.namespaceEnv(conversationId), undefined);
    handle.contract.restoreDraft(spec?.specDraft ?? null);
    handle.contract.allowPendingGated();
    handle.contract.approveExecution();
    return true;
  }

  /** #80 fix 3: retry re-executes against the same spec (or the original
   *  prompt when the turn never had one). */
  async retryExecution(conversationId: string): Promise<boolean> {
    const spec = this.opts.store.getThreadSpecById(conversationId);
    const handle = await this.prepareTurn(conversationId, this.namespaceEnv(conversationId), undefined);
    handle.contract.restoreDraft(spec?.specDraft ?? null);
    if (spec?.specDraft) {
      handle.contract.retryExecution();
      return true;
    }
    const last = this.opts.store.getLastPromptById(conversationId);
    if (!last) return false;
    handle.contract.beginExecution();
    await handle.rpc.send({ type: "prompt", message: last });
    return true;
  }

  /**
   * Review (ADR-0004): approve/retry can spawn a NEW session host (no live
   * host after a gateway restart or host death), and the child env decides
   * the memory namespace at module load. Resolving the conversation's
   * namespace here (the same resolution autonomyFor uses) keeps memory
   * writes out of the default namespace on the respawn path too.
   */
  private namespaceEnv(conversationId: string): Record<string, string> {
    const ns = this.opts.store.getNamespaceById(conversationId);
    return ns ? { LAPIS_PROJECT_KEY: ns } : {};
  }

  /** #80 fix 6: spec drafts/answers reach the live agent. */
  submitSpecPatch(conversationId: string, body: PatchSpecBody): void {
    const handle = this.handles.get(conversationId);
    if (!handle || handle.exiting) return;
    handle.contract.submitSpecPatch(body);
  }

  /** Abandon publishes the terminal status via the contract, then kills. */
  abandonThread(conversationId: string): void {
    this.handles.get(conversationId)?.contract.abandon();
    this.killChild(conversationId);
  }

  /** #81.3: autonomy from the namespace's merge track record. */
  private autonomyFor(conversationId: string): Autonomy {
    const ns = this.opts.store.getNamespaceById(conversationId);
    if (!ns) return "standard";
    const threshold = this.opts.trustThreshold ?? 5;
    if (threshold <= 0) return "standard";
    return this.opts.store.getTrustCount(ns) >= threshold ? "established" : "standard";
  }

  async abort(conversationId: string): Promise<boolean> {
    const handle = this.handles.get(conversationId);
    // An exiting host is already going down; writing to its stdin would
    // only park this call until the rpc timeout.
    if (!handle || handle.exiting) return false;
    handle.lastActivity = Date.now();
    const res = await handle.rpc.send({ type: "abort" });
    return res.success;
  }

  /**
   * #77: resolves once the child has exited (already-dead children resolve
   * immediately). Bounded by the kill grace + a small margin, so a child
   * that ignores every signal can't hang a prompt forever.
   */
  private exitOf(handle: Handle): Promise<void> {
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, (this.opts.killGraceMs ?? 2_000) + 250);
      timer.unref();
      handle.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * #77: SIGTERM first, escalate to SIGKILL after the kill grace. A pi that
   * ignores SIGTERM used to stay alive forever (reaper deleted the handle
   * right after SIGTERM — unkillable orphan) or died instantly (killChild's
   * unconditional SIGKILL, losing the graceful-drain chance).
   */
  private sigtermWithEscalation(handle: Handle): void {
    handle.child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (handle.child.exitCode === null && handle.child.signalCode === null) {
        handle.child.kill("SIGKILL");
      }
    }, this.opts.killGraceMs ?? 2_000);
    timer.unref();
    handle.child.once("exit", () => clearTimeout(timer));
  }

  killChild(conversationId: string): void {
    const handle = this.handles.get(conversationId);
    if (!handle) return;
    // #85, reworked (review P1): mark exiting + forget the handle BEFORE the
    // kill so the async exit path doesn't publish a spurious degraded
    // session_state. The dead-mark is keyed by CHILD IDENTITY (handle.zombie),
    // not the conversation: only the old child's in-flight events are
    // dropped, and prepareTurn awaits the zombie's exit before spawning a
    // replacement (abandon → re-prompt delivers the new host immediately).
    handle.exiting = true;
    this.handles.delete(conversationId);
    const zombie = this.exitOf(handle);
    handle.zombie = zombie;
    const pending = this.zombies.get(conversationId) ?? [];
    pending.push(zombie);
    this.zombies.set(conversationId, pending);
    void zombie.then(() => {
      const list = this.zombies.get(conversationId);
      if (!list) return;
      const next = list.filter((p) => p !== zombie);
      if (next.length === 0) this.zombies.delete(conversationId);
      else this.zombies.set(conversationId, next);
    });
    this.sigtermWithEscalation(handle);
  }

  private onProtocolEvent(handle: Handle, ev: RpcEvent): void {
    try {
      this.handleProtocolEvent(handle, ev);
    } catch {
      // Store / bus may be closed during disposeAll (test teardown race) or
      // a real SIGTERM during shutdown. Spec §10: backing service failures
      // fail soft — drop the event rather than crash the gateway.
    }
  }

  private handleProtocolEvent(handle: Handle, ev: RpcEvent): void {
    // Review P1 rework: drop events only from a killed OLD child (identity-
    // keyed). A respawned host's events must never be silenced.
    if (handle.zombie) return;
    const conversationId = handle.conversationId;
    const live = this.handles.get(conversationId);
    if (live) live.lastActivity = Date.now();

    // Probe channel: custom_* protocol events are forwarded onto the bus.
    // Security review #85: they must not flow verbatim as the envelope kind
    // (a kind with a newline desyncs SSE framing) — they are wrapped in the
    // schema-validated "custom" kind instead. Events whose type falls
    // outside the safe charset are dropped.
    if (ev.type === "custom_spec_question" || ev.type === "custom_spec_draft") {
      // #80: the agent's spec-protocol signals — the contract translates
      // them into schema-validated envelopes + lifecycle transitions.
      handle?.contract.onProtocolEvent(ev);
      return;
    }
    if (ev.type === "message_end") {
      // Dogfood 2026-10-09: real pi delivers spec signals inside the
      // assistant's text (see extractSpecSignals). Scanning here feeds the
      // contract the same events the fixture emits at top level. A signal
      // that arrives BOTH ways is schema-validated twice — the contract
      // tolerates that (the duplicate fails safeParse and publishes an
      // error envelope) and no real pi emits both today.
      const message = ev.message as
        | { role?: string; content?: Array<Record<string, unknown>> }
        | undefined;
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type !== "text" || typeof block.text !== "string") continue;
          for (const signal of extractSpecSignals(block.text)) {
            handle?.contract.onProtocolEvent(signal);
          }
        }
      }
      return;
    }
    if (ev.type.startsWith("custom_")) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(ev.type)) return;
      this.publish(conversationId, {
        kind: "custom",
        payload: { type: ev.type, data: ev },
      });
      return;
    }
    if (ev.type === "message_update") {
      const ame = ev.assistantMessageEvent as
        | { type?: string; delta?: string }
        | undefined;
      if (ame?.type === "text_delta" && typeof ame.delta === "string") {
        this.publish(conversationId, { kind: "text_delta", payload: { delta: ame.delta } });
      }
      return;
    }
    if (ev.type === "tool_execution_start") {
      this.publish(conversationId, {
        kind: "tool_call",
        payload: {
          toolCallId: String(ev.toolCallId),
          toolName: String(ev.toolName),
          args: ev.args,
        },
      });
      // #81: every live action passes the risk classifier; the verdict is
      // the laya_verdict envelope's producer. Gated actions stop the run
      // unless the user already approved exactly this class of action.
      const toolName = String(ev.toolName);
      const verdict = classifyAction(toolName, ev.args, {
        autonomy: this.autonomyFor(conversationId),
      });
      this.publish(conversationId, {
        kind: "laya_verdict",
        payload: {
          tool: "risk-classifier",
          verdict: {
            stage: "tool",
            tool: toolName,
            cls: verdict.cls,
            gated: verdict.gated,
            allowed: !verdict.gated || (handle?.contract.isActionAllowed(verdict.reason) ?? false),
            reason: verdict.reason,
          },
        },
      });
      if (verdict.gated && !(handle?.contract.isActionAllowed(verdict.reason) ?? false)) {
        this.escalateGate(conversationId, handle, verdict.reason);
      }
      return;
    }
    if (ev.type === "tool_execution_end") {
      this.publish(conversationId, {
        kind: "tool_result",
        payload: { toolCallId: String(ev.toolCallId), isError: Boolean(ev.isError) },
      });
      return;
    }
    if (ev.type === "agent_settled") {
      // #81 + review: a gate stop owns the conversation state — the abort it
      // issued ends the turn with a settle, and letting that settle write
      // "idle" would erase the blocked escalation (the same race CI caught
      // for #84 dialogs). The thread stays blocked until POST /approve.
      // Review SHOULD-FIX: the abort is async, so its settle can arrive
      // AFTER a newer user turn un-parked the thread (beginUserTurn clears
      // gateStopped). pendingAbortSettle identifies that leftover: it is
      // consumed and dropped — no idle write over the live turn's
      // "streaming", no usage harvest, no post-turn pipeline over the
      // aborted half-turn. The new turn's own settle finds the marker clear
      // and proceeds normally. Scoping note: the marker freezes the turn
      // the gate belonged to; a respawned host is a fresh handle and never
      // inherits it.
      if (handle?.contract.gateStopped) {
        handle.pendingAbortSettle = false;
        return;
      }
      if (handle?.pendingAbortSettle) {
        handle.pendingAbortSettle = false;
        return;
      }
      this.opts.store.setConversationState(conversationId, "idle");
      this.publish(conversationId, { kind: "session_state", payload: { state: "idle" } });
      if (handle) void this.harvestUsage(conversationId, handle);
      // #80 fix 4 + #82: the settle pipeline — diff producer, verify loop,
      // reviewed transition. Interview/gate stops stand down.
      if (handle) void this.postTurnPipeline(conversationId, handle);
      return;
    }
    if (ev.type === "extension_ui_request") {
      this.handleExtensionUiRequest(conversationId, handle, ev);
      return;
    }
    if (ev.type === "extension_error") {
      this.publish(conversationId, {
        kind: "error",
        payload: { message: `extension error in ${String(ev.extensionPath)}` },
      });
    }
  }

  /**
   * #81: a gated action (install/migration/delete/deploy/...) fired without
   * the user having approved it. Stop the run, mark the thread blocked with
   * the "gated" reason, and record the action so POST /approve can allow
   * exactly it on the next round.
   */
  private escalateGate(conversationId: string, handle: Handle | undefined, reason: string): void {
    if (handle) {
      // One abort marker per gated turn: repeat gated actions in the same
      // turn re-use it (the turn still ends with a single settle).
      if (!handle.contract.gateStopped) handle.pendingAbortSettle = true;
      handle.contract.gateStopped = true;
      handle.contract.notePendingGated(reason);
    }
    try {
      this.opts.store.setConversationState(conversationId, "blocked");
      this.publish(conversationId, { kind: "session_state", payload: { state: "blocked", reason: "gated" } });
      this.publish(conversationId, {
        kind: "error",
        payload: {
          message: `Stopped before a gated action (${reason}). Review it, then approve to continue.`,
          code: "gated_action",
        },
      });
    } catch {
      // store closed (shutdown); ignore
    }
    // Best-effort: stop the turn BEFORE the irreversible action completes.
    // Real pi honors abort; if the child already ran it, the diff review is
    // the backstop.
    void this.abort(conversationId);
  }

  /**
   * #80 fix 4 + #82: runs after every settle whose turn wasn't an
   * outstanding interview or a gate stop.
   *  - edits?  -> compute the workspace diff (gateway owns the cwd), emit
   *               the diff envelope, transition reviewed.
   *  - verify? -> run tests/lint/typecheck; feed failures back to the agent
   *               with a bounded retry budget; escalate to the user only
   *               with failure context attached.
   */
  private async postTurnPipeline(conversationId: string, handle: Handle): Promise<void> {
    const contract = handle.contract;
    if (contract.gateStopped || contract.awaitingInterview) return;
    // Review P2: the pipeline is async (diff producer, verify runner) — a
    // newer user turn may start on this host while it runs. `generation`
    // captures OUR turn; every mutation past an await re-checks so a stale
    // pipeline can neither inject a verify-retry into the new turn nor mark
    // a live thread reviewed underneath it.
    const generation = handle.turnGeneration;
    const stale = (): boolean => handle.turnGeneration !== generation;
    try {
      const workspace = this.opts.store.getConversationById(conversationId)?.workspace ?? undefined;
      if (!workspace) return;
      const diff = await (this.opts.computeDiff ?? computeWorkspaceDiff)(workspace);
      if (!diff || diff.length === 0) return;

      this.publish(conversationId, { kind: "diff", payload: { files: diff } });

      const verify = this.opts.verify;
      if (verify === null) {
        if (!stale()) this.markReviewed(conversationId);
        return;
      }
      const commands = await resolveVerifyCommands(workspace, verify?.commandsOverride);
      if (commands.length === 0) {
        if (!stale()) this.markReviewed(conversationId);
        return;
      }
      const retries = verify?.retries ?? 3;
      const run = await runVerification({
        cwd: workspace,
        commands,
        timeoutMs: verify?.timeoutMs,
        exec: verify?.exec,
      });
      if (run.ok) {
        if (!stale()) this.markReviewed(conversationId);
        return;
      }
      // The attempt belongs to OUR turn — never burn the newer turn's budget.
      if (stale()) return;
      handle.verifyAttempts++;
      const failure = formatFailure(run);
      if (handle.verifyAttempts > retries) {
        // Budget exhausted — escalate WITH the failure context attached (#82).
        this.publish(conversationId, {
          kind: "error",
          payload: {
            code: "verify_exhausted",
            message: `auto-verify failed after ${retries} retries — needs your review:\n\n${failure.slice(0, 2_000)}`,
          },
        });
        if (!stale()) this.markReviewed(conversationId);
        return;
      }
      // A newer turn owns the host now — injecting the verify-retry would
      // corrupt it (review P2).
      if (stale()) return;
      // Bounded self-retry: the failure output goes back to the agent and
      // the next settle re-enters this pipeline with a fresh diff.
      this.publish(conversationId, {
        kind: "error",
        payload: {
          code: "verify_failed",
          message: `verification failed (attempt ${handle.verifyAttempts}/${retries}) — retrying automatically`,
        },
      });
      this.opts.store.setConversationState(conversationId, "streaming");
      this.publish(conversationId, { kind: "session_state", payload: { state: "streaming" } });
      await handle.rpc.send({ type: "prompt", message: buildVerifyRetryPrompt(failure) });
    } catch {
      // diff/verify infrastructure failed — fail soft, leave the turn done
    }
  }

  private markReviewed(conversationId: string): void {
    try {
      this.opts.store.markThreadReviewedById(conversationId);
      this.publish(conversationId, { kind: "spec_status", payload: { status: "reviewed" } });
    } catch {
      // store closed (shutdown); ignore
    }
  }

  private publish(
    conversationId: string,
    part: { kind: EventEnvelope["kind"]; payload: unknown },
  ): void {
    this.opts.bus.publish({
      conversationId,
      ts: new Date().toISOString(),
      kind: part.kind,
      payload: part.payload,
    } as Parameters<EventBus["publish"]>[0]);
  }

  /**
   * #84: per-thread cost/token accounting. pi's get_session_stats returns
   * cumulative SessionStats for the session file, so the latest observation
   * IS the thread total (a respawned host resumes the same session).
   * Fire-and-forget: a stats failure never affects the turn itself.
   */
  private async harvestUsage(conversationId: string, handle: Handle): Promise<void> {
    try {
      const res = await handle.rpc.send({ type: "get_session_stats" });
      if (!res.success || !res.data) return;
      const stats = res.data as { tokens?: Record<string, unknown>; cost?: unknown };
      if (!stats.tokens) return;
      // Review P3: tokens are ints in the shared Usage schema — fractional
      // pi stats must be coerced (not dropped by the envelope's zod probe).
      const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
      const int = (v: unknown): number => Math.floor(num(v));
      const usage = {
        tokens: {
          input: int(stats.tokens.input),
          output: int(stats.tokens.output),
          cacheRead: int(stats.tokens.cacheRead),
          cacheWrite: int(stats.tokens.cacheWrite),
          total: int(stats.tokens.total),
        },
        cost: num(stats.cost),
      };
      this.publish(conversationId, { kind: "usage", payload: usage });
      this.opts.store.recordUsage(conversationId, usage);
      // #84: budget enforcement. The finished turn still delivered its
      // output; the blocked state + route guard stop the NEXT turn.
      const cap = this.opts.maxCostPerThreadUsd;
      if (cap !== undefined && usage.cost >= cap) {
        this.blockThread(conversationId, "capped");
      }
    } catch {
      // rpc closed (host exiting mid-harvest); ignore
    }
  }

  /** #84: needs-you escalation — set the blocked conversation state and
   *  publish a session_state envelope with the reason. */
  private blockThread(conversationId: string, reason: "question" | "dialog" | "capped"): void {
    try {
      this.opts.store.setConversationState(conversationId, "blocked");
      this.publish(conversationId, { kind: "session_state", payload: { state: "blocked", reason } });
    } catch {
      // store closed (shutdown); ignore
    }
  }

  /**
   * #84 (spec §14.3): pi's extension_ui_request dialogs block the agent
   * until answered, silently hanging any headless autonomous run. The
   * auto-responder (default) answers every request cancelled — the agent
   * keeps moving and the dialog is visible on the thread for observability.
   * dialogMode "blocked" escalates blocking dialogs (select/confirm/input/
   * editor) to the blocked state instead.
   */
  private handleExtensionUiRequest(
    conversationId: string,
    handle: Handle | undefined,
    ev: RpcEvent,
  ): void {
    const method = typeof ev.method === "string" ? ev.method : "unknown";
    const title = typeof ev.title === "string" ? ev.title : "agent dialog";
    const id = typeof ev.id === "string" ? ev.id : "";
    const blocking = method === "select" || method === "confirm" || method === "input" || method === "editor";
    const escalate = blocking && this.opts.dialogMode === "blocked";

    if (escalate) {
      this.blockThread(conversationId, "dialog");
      this.publish(conversationId, { kind: "dialog", payload: { method, title, action: "blocked" } });
      return;
    }
    // Answer cancelled (never resolves a value on the agent's behalf) so the
    // run continues. Non-blocking requests (notify/setStatus/...) get the
    // same treatment for observability.
    if (id && handle) {
      void handle.rpc
        .send({ type: "extension_ui_response", id, cancelled: true })
        .catch(() => {});
    }
    this.publish(conversationId, {
      kind: "dialog",
      payload: { method, title, action: "auto_cancelled" },
    });
  }

  private reapIdle(): void {
    const now = Date.now();
    for (const handle of this.handles.values()) {
      // Already being torn down (reap or kill in flight): its SIGKILL
      // escalation is pending and the exit listener will clean up.
      if (handle.exiting) continue;
      if (now - handle.lastActivity > this.opts.idleMs) {
        handle.exiting = true;
        // #77: keep the handle in the map until 'exit' fires. Deleting it
        // here used to let the next prompt spawn a SECOND pi on the same
        // session file while the SIGTERMed original was still alive, and
        // left the original as an unkillable orphan if it ignored SIGTERM.
        // sigtermWithEscalation guarantees the exit actually happens.
        this.sigtermWithEscalation(handle);
      }
    }
  }

  /**
   * Async: SIGTERM every child, wait for each to exit (or the timeout),
   * then clear the handle map. Used by Fastify's onClose hook during
   * graceful shutdown so in-flight prompts don't get killed mid-send.
   * #77: a child that ignores SIGTERM is SIGKILLed at the timeout instead
   * of being orphaned past shutdown.
   */
  async disposeAll(timeoutMs = 5_000): Promise<void> {
    clearInterval(this.reaper);
    const waits: Promise<void>[] = [];
    for (const [, handle] of this.handles) {
      if (!handle.exiting) {
        handle.exiting = true;
        handle.child.kill("SIGTERM");
      }
      waits.push(
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (handle.child.exitCode === null && handle.child.signalCode === null) {
              handle.child.kill("SIGKILL");
            }
            resolve();
          }, timeoutMs);
          handle.child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        }),
      );
    }
    await Promise.all(waits);
    this.handles.clear();
  }
}
