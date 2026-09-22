import { spawn, type ChildProcess } from "node:child_process";
import type { EventEnvelope } from "@aelvyril/shared";
import { RpcClient, type RpcEvent } from "./rpc.js";
import type { EventBus } from "./bus.js";
import type { Store } from "./store.js";

export interface SupervisorOptions {
  bus: EventBus;
  store: Store;
  spawnChild: () => ChildProcess;
  idleMs: number;
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

  private ensureSession(conversationId: string): Handle {
    const existing = this.handles.get(conversationId);
    if (existing) return existing;
    const child = this.opts.spawnChild();
    const rpc = new RpcClient(child);
    const handle: Handle = { rpc, child, lastActivity: Date.now(), exiting: false };
    rpc.on("event", (ev: RpcEvent) => this.onProtocolEvent(conversationId, ev));
    rpc.on("exit", () => {
      if (handle.exiting) return;
      this.handles.delete(conversationId);
      this.opts.store.setConversationState(conversationId, "degraded");
      this.publish(conversationId, { kind: "session_state", payload: { state: "degraded" } });
    });
    this.handles.set(conversationId, handle);
    return handle;
  }

  /**
   * Resolves once the child acknowledges the command AND the turn settles
   * (agent_settled) or the child exits — so callers observe a settled state
   * on return (crash mid-turn resolves via exit, never hangs). Envelopes are
   * published live during the turn regardless.
   */
  async prompt(
    conversationId: string,
    message: string,
    streamingBehavior?: "steer" | "followUp",
  ): Promise<boolean> {
    const handle = this.ensureSession(conversationId);
    this.opts.store.setConversationState(conversationId, "streaming");
    this.publish(conversationId, { kind: "session_state", payload: { state: "streaming" } });
    handle.lastActivity = Date.now();
    // Attach the settle listener BEFORE sending so a fast turn can't slip by.
    const settled = new Promise<void>((resolve) => {
      const onEvent = (ev: RpcEvent): void => {
        if (ev.type === "agent_settled") {
          handle.rpc.off("event", onEvent);
          handle.rpc.off("exit", onExit);
          resolve();
        }
      };
      const onExit = (): void => {
        handle.rpc.off("event", onEvent);
        resolve();
      };
      handle.rpc.on("event", onEvent);
      handle.rpc.on("exit", onExit);
    });
    const command: Record<string, unknown> = { type: "prompt", message };
    if (streamingBehavior) command.streamingBehavior = streamingBehavior;
    const res = await handle.rpc.send(command);
    await settled;
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
    const handle = this.handles.get(conversationId);
    if (handle) handle.lastActivity = Date.now();

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

  disposeAll(): void {
    clearInterval(this.reaper);
    for (const [, handle] of this.handles) {
      handle.exiting = true;
      handle.child.kill("SIGTERM");
    }
    this.handles.clear();
  }
}
