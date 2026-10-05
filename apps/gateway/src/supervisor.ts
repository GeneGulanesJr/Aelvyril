import type { ChildProcess } from "node:child_process";
import type { EventEnvelope } from "@aelvyril/shared";
import { RpcClient, type RpcEvent } from "./rpc.js";
import type { EventBus } from "./bus.js";
import type { Store } from "./store.js";

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
}

interface Handle {
  rpc: RpcClient;
  child: ChildProcess;
  lastActivity: number;
  exiting: boolean;
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
  /** Security review #85: conversations whose host was SIGKILLed via
   *  killChild (delete/abandon). Protocol events already queued in the
   *  event loop for these ids are dropped instead of published, which
   *  would re-insert orphan event rows for deleted threads. */
  private dead = new Set<string>();

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
    const spawnCwd = cwd ?? this.opts.store.getConversationById(conversationId)?.workspace ?? undefined;
    const child = this.opts.spawnChild(conversationId, extraEnv, spawnCwd);
    const rpc = new RpcClient(child);
    const handle: Handle = { rpc, child, lastActivity: Date.now(), exiting: false };
    rpc.on("event", (ev: RpcEvent) => this.onProtocolEvent(conversationId, ev));
    rpc.on("exit", () => {
      // The host exited — the gauge reflects that regardless of whether the
      // exit was expected (kill/reap/dispose) or a crash.
      this.opts.onSessionHostExit?.();
      // The kill is complete: in-flight events from the old child are done
      // arriving. Lift the dead mark so a future prompt on this thread
      // (abandon → change mind → re-prompt) spawns a live host whose events
      // are not silently dropped (2nd review).
      this.dead.delete(conversationId);
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
  ): Promise<boolean> {
    // #77: an idle-reaped host keeps its handle until its exit fires. Wait
    // for it so this prompt is not written into a dying child's stdin and
    // does not double-spawn a second pi on the same session file while the
    // SIGTERMed original is still alive.
    const existing = this.handles.get(conversationId);
    if (existing?.exiting) await this.exitOf(existing);
    // extraEnv + cwd only apply at spawn time; a reused session keeps its env.
    const handle = this.ensureSession(conversationId, extraEnv ?? {}, cwd);
    this.opts.store.setConversationState(conversationId, "streaming");
    this.publish(conversationId, { kind: "session_state", payload: { state: "streaming" } });
    handle.lastActivity = Date.now();
    const command: Record<string, unknown> = { type: "prompt", message };
    if (streamingBehavior) command.streamingBehavior = streamingBehavior;
    const res = await handle.rpc.send(command);
    return res.success;
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
    // #85: mark exiting + forget the handle BEFORE the kill so the async
    // exit path doesn't publish a spurious degraded session_state, and add
    // to the dead set so in-flight protocol events are dropped.
    handle.exiting = true;
    this.handles.delete(conversationId);
    this.dead.add(conversationId);
    this.sigtermWithEscalation(handle);
  }

  private onProtocolEvent(conversationId: string, ev: RpcEvent): void {
    try {
      this.handleProtocolEvent(conversationId, ev);
    } catch {
      // Store / bus may be closed during disposeAll (test teardown race) or
      // a real SIGTERM during shutdown. Spec §10: backing service failures
      // fail soft — drop the event rather than crash the gateway.
    }
  }

  private handleProtocolEvent(conversationId: string, ev: RpcEvent): void {
    if (this.dead.has(conversationId)) return;
    const handle = this.handles.get(conversationId);
    if (handle) handle.lastActivity = Date.now();

    // Probe channel: custom_* protocol events are forwarded onto the bus.
    // Security review #85: they must not flow verbatim as the envelope kind
    // (a kind with a newline desyncs SSE framing) — they are wrapped in the
    // schema-validated "custom" kind instead. Events whose type falls
    // outside the safe charset are dropped.
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
      this.opts.store.setConversationState(conversationId, "idle");
      this.publish(conversationId, { kind: "session_state", payload: { state: "idle" } });
      if (handle) void this.harvestUsage(conversationId, handle);
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
      const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
      const usage = {
        tokens: {
          input: num(stats.tokens.input),
          output: num(stats.tokens.output),
          cacheRead: num(stats.tokens.cacheRead),
          cacheWrite: num(stats.tokens.cacheWrite),
          total: num(stats.tokens.total),
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
