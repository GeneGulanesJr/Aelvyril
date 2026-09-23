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

  constructor(private opts: SupervisorOptions) {
    this.reaper = setInterval(() => this.reapIdle(), Math.min(opts.idleMs, 5_000));
    this.reaper.unref();
  }

  has(conversationId: string): boolean {
    return this.handles.has(conversationId);
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
      if (handle.exiting) return;
      this.handles.delete(conversationId);
      this.opts.onSessionHostExit?.();
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
    if (!handle) return false;
    handle.lastActivity = Date.now();
    const res = await handle.rpc.send({ type: "abort" });
    return res.success;
  }

  killChild(conversationId: string): void {
    const handle = this.handles.get(conversationId);
    if (!handle) return;
    handle.child.kill("SIGKILL");
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
    const handle = this.handles.get(conversationId);
    if (handle) handle.lastActivity = Date.now();

    // Probe channel: custom_* protocol events are forwarded verbatim onto the
    // bus (kind is stored as free TEXT; the SSE wire layer does not re-validate
    // against the zod union). Used by tests to observe child-side state such
    // as the spawn environment.
    if (ev.type.startsWith("custom_")) {
      this.publish(conversationId, {
        kind: ev.type as EventEnvelope["kind"],
        payload: ev,
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

  private reapIdle(): void {
    const now = Date.now();
    for (const [id, handle] of this.handles) {
      if (now - handle.lastActivity > this.opts.idleMs) {
        handle.exiting = true;
        handle.child.kill("SIGTERM");
        this.handles.delete(id);
      }
    }
  }

  /**
   * Async: SIGTERM every child, wait for each to exit (or 5s timeout),
   * then clear the handle map. Used by Fastify's onClose hook during
   * graceful shutdown so in-flight prompts don't get killed mid-send.
   */
  async disposeAll(timeoutMs = 5_000): Promise<void> {
    clearInterval(this.reaper);
    const waits: Promise<void>[] = [];
    for (const [, handle] of this.handles) {
      handle.exiting = true;
      handle.child.kill("SIGTERM");
      waits.push(
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => resolve(), timeoutMs);
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
