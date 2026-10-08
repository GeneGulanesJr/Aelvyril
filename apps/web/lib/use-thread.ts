"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { GatewayClient } from "./api.js";
import type { EventEnvelope, SpecDraft, SpecQuestion, ThreadStatus, Usage } from "@aelvyril/shared";

export interface ThreadState {
  status: ThreadStatus;
  /** True once a live spec_status envelope arrived — before that, `status`
   *  is just the hook's initial value and must not override the thread
   *  list's snapshot (#83 live header status). */
  statusLive: boolean;
  questions: SpecQuestion[];
  draft: SpecDraft | null;
  plan: string[];
  trace: string[];
  diff: { path: string; patch: string }[];
  error: string | null;
  /** Session host died mid-turn — next prompt respawns it (spec §10). */
  degraded: boolean;
  /** #84: needs-you escalation reason (drives the orange blocked banner).
   *  #81: "gated" = the risk classifier stopped an irreversible action. */
  blocked: "question" | "dialog" | "capped" | "gated" | null;
  /** A prompt is in flight (drives the Stop button + steer-queued sends). */
  waiting: boolean;
  /** #84: cumulative cost/token usage for this thread (live via SSE). */
  usage: Usage | null;
}

export interface UseThreadDeps {
  /** Clerk token getter — threaded through so the hook stays render-agnostic. */
  getToken?: () => Promise<string | null>;
  gatewayUrl?: string;
  /** Live status updates for the sidebar (#83): fired on each spec_status
   *  envelope so the ACTIVE entry in the thread list tracks the header pill
   *  instead of its mount-time snapshot. Kept as a callback because the
   *  threads list itself lives above the hook. */
  onStatus?: (status: ThreadStatus) => void;
}

/** Clean slate for a thread — also the reset target when threadId changes. */
const initialThreadState: ThreadState = {
  status: "draft",
  statusLive: false,
  questions: [],
  draft: null,
  plan: [],
  trace: [],
  diff: [],
  error: null,
  degraded: false,
  blocked: null,
  waiting: false,
  usage: null,
};

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useThread(
  threadId: string | null,
  deps: UseThreadDeps = {},
): ThreadState & {
  /** Resolves true when the prompt was accepted, false when it failed
   *  (the error banner is set) — callers use it to keep typed text alive. */
  ask: (prompt: string, specMode: "auto" | "force" | "off") => Promise<boolean>;
  submitAnswers: (answers: Record<string, string>) => Promise<void>;
  editSpec: (field: "goal" | "filesAffected" | "plan" | "risks", value: string | string[]) => Promise<void>;
  approve: () => Promise<void>;
  abandon: () => Promise<void>;
  retry: () => Promise<void>;
  merge: () => Promise<void>;
  stop: () => Promise<void>;
  dismissError: () => void;
} {
  const { getToken, gatewayUrl, onStatus } = deps;
  const [state, setState] = useState<ThreadState>(initialThreadState);
  const clientRef = useRef<GatewayClient | null>(null);
  // Ref so a fresh inline callback per render can't re-open the stream (the
  // effect below intentionally doesn't depend on it).
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  useEffect(() => {
    if (!threadId) return;
    // Navigating A→B must not bleed A's trace/questions/draft/error/usage
    // into B (and B's replay would otherwise append onto A's trace): reset
    // to a clean slate whenever the id changes; the SSE replay re-fills it.
    setState({ ...initialThreadState });
    const client = new GatewayClient(
      gatewayUrl ?? (process.env.NEXT_PUBLIC_GATEWAY_URL as string | undefined) ?? "http://localhost:8787",
      getToken ?? (async () => null),
    );
    clientRef.current = client;
    // fetch-based SSE (NOT EventSource — it cannot send an Authorization
    // header); openStream owns reconnect + Last-Event-ID. A terminal stream
    // loss (#85: 404 or repeated failures) surfaces in the error banner
    // instead of an invisible 1s retry loop.
    const close = client.openStream(
      threadId,
      (e) => {
        setState((s) => applyEnvelope(s, e));
        // #83 sidebar: forward authoritative live status so the thread list's
        // ACTIVE entry tracks the header pill (the list itself lives above).
        if (e.kind === "spec_status") onStatusRef.current?.(e.payload.status);
      },
      undefined,
      (reason) =>
        // Terminal stream loss must not leave a turn "in flight" forever:
        // the Stop button and steer-queued sends would persist against a
        // dead stream until reload. waiting reuses the existing shape; the
        // error banner carries the stream-loss messaging (degraded stays
        // reserved for the session host actually dying, via session_state).
        setState((s) => ({
          ...s,
          waiting: false,
          error:
            reason === "not_found"
              ? "This thread no longer exists."
              : "Live updates stopped after repeated failures — reload to reconnect.",
        })),
    );
    return () => {
      close();
      clientRef.current = null;
    };
  }, [threadId, getToken, gatewayUrl]);

  const ask = useCallback(
    async (message: string, specMode: "auto" | "force" | "off"): Promise<boolean> => {
      if (!clientRef.current || !threadId) return false;
      // Spec §6: a send while a turn is mid-flight queues as a steer.
      const steer = state.waiting ? { streamingBehavior: "steer" as const } : {};
      setState((s) => ({ ...s, waiting: true }));
      try {
        await clientRef.current.prompt(threadId, { message, specMode, ...steer });
        return true;
      } catch (err) {
        setState((s) => ({ ...s, error: toErrorMessage(err) }));
        return false;
      } finally {
        setState((s) => ({ ...s, waiting: false }));
      }
    },
    [threadId, state.waiting],
  );

  // Mutations are fire-and-forget at the call sites, so a rejection must
  // land in the error banner instead of escaping as an unhandled rejection.
  const run = useCallback(async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (err) {
      setState((s) => ({ ...s, error: toErrorMessage(err) }));
    }
  }, []);

  const stop = useCallback(async () => {
    const client = clientRef.current;
    if (!client || !threadId) return;
    await run(() => client.abortThread(threadId));
    setState((s) => ({ ...s, waiting: false }));
  }, [threadId, run]);

  const dismissError = useCallback(() => {
    setState((s) => ({ ...s, error: null }));
  }, []);

  const submitAnswers = useCallback(
    async (answers: Record<string, string>) => {
      const client = clientRef.current;
      if (!client || !threadId) return;
      await run(() => client.patchSpec(threadId, { kind: "answer", answers }));
    },
    [threadId, run],
  );

  const editSpec = useCallback(
    async (field: "goal" | "filesAffected" | "plan" | "risks", value: string | string[]) => {
      const client = clientRef.current;
      if (!client || !threadId) return;
      await run(() => client.patchSpec(threadId, { kind: "edit", field, value }));
    },
    [threadId, run],
  );

  const approve = useCallback(async () => {
    const client = clientRef.current;
    if (!client || !threadId) return;
    await run(() => client.approveSpec(threadId));
  }, [threadId, run]);

  const abandon = useCallback(async () => {
    const client = clientRef.current;
    if (!client || !threadId) return;
    await run(() => client.abandonThread(threadId));
  }, [threadId, run]);

  const retry = useCallback(async () => {
    const client = clientRef.current;
    if (!client || !threadId) return;
    await run(() => client.retryThread(threadId));
  }, [threadId, run]);

  // #80: accept the reviewed diff (reviewed → merged).
  const merge = useCallback(async () => {
    const client = clientRef.current;
    if (!client || !threadId) return;
    await run(() => client.mergeThread(threadId));
  }, [threadId, run]);

  return { ...state, ask, submitAnswers, editSpec, approve, abandon, retry, merge, stop, dismissError };
}

function applyEnvelope(s: ThreadState, e: EventEnvelope): ThreadState {
  switch (e.kind) {
    case "spec_status":
      return { ...s, status: e.payload.status, statusLive: true };
    case "spec_question":
      return { ...s, questions: e.payload.questions };
    case "spec_draft":
      return { ...s, draft: e.payload.draft, plan: e.payload.draft.plan };
    case "text_delta":
      return { ...s, trace: [...s.trace, e.payload.delta] };
    case "tool_call": {
      // Display-only reduction: the gated banner (#81) tells users to
      // "review it in the trace", so tool activity must appear there.
      const args = e.payload.args === undefined ? "" : JSON.stringify(e.payload.args);
      return { ...s, trace: [...s.trace, `→ ${e.payload.toolName}(${args})`] };
    }
    case "tool_result":
      return { ...s, trace: [...s.trace, `← ${e.payload.isError ? "error" : "ok"}`] };
    case "dialog":
      // #84: surfaced/auto-answered dialogs stay auditable in the trace.
      return {
        ...s,
        trace: [...s.trace, `dialog: ${e.payload.title} (${e.payload.action})`],
      };
    case "diff":
      return { ...s, diff: e.payload.files };
    case "error":
      return { ...s, error: e.payload.message };
    case "usage":
      // #84: cumulative cost/token accounting, harvested at turn settle.
      return { ...s, usage: e.payload };
    case "session_state":
      // Spec §10: degraded means the host died mid-turn; the next prompt
      // respawns it. streaming/idle drive the waiting flag for Stop + steer.
      // #84: blocked is the needs-you escalation with a reason.
      return {
        ...s,
        degraded: e.payload.state === "degraded",
        blocked:
          e.payload.state === "blocked" ? (e.payload.reason ?? "dialog") : null,
        waiting: e.payload.state === "streaming",
      };
    default:
      return s;
  }
}
