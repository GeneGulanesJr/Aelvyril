"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { GatewayClient } from "./api.js";
import type { EventEnvelope, SpecDraft, SpecQuestion, ThreadStatus } from "@aelvyril/shared";

export interface ThreadState {
  status: ThreadStatus;
  questions: SpecQuestion[];
  draft: SpecDraft | null;
  plan: string[];
  trace: string[];
  diff: { path: string; patch: string }[];
  error: string | null;
  /** Session host died mid-turn — next prompt respawns it (spec §10). */
  degraded: boolean;
  /** A prompt is in flight (drives the Stop button + steer-queued sends). */
  waiting: boolean;
}

export interface UseThreadDeps {
  /** Clerk token getter — threaded through so the hook stays render-agnostic. */
  getToken?: () => Promise<string | null>;
  gatewayUrl?: string;
}

export function useThread(
  threadId: string | null,
  deps: UseThreadDeps = {},
): ThreadState & {
  ask: (prompt: string, specMode: "auto" | "force" | "off") => Promise<void>;
  submitAnswers: (answers: Record<string, string>) => Promise<void>;
  editSpec: (field: "goal" | "filesAffected" | "plan" | "risks", value: string | string[]) => Promise<void>;
  approve: () => Promise<void>;
  abandon: () => Promise<void>;
  retry: () => Promise<void>;
} {
  const { getToken, gatewayUrl } = deps;
  const [state, setState] = useState<ThreadState>({
    status: "draft",
    questions: [],
    draft: null,
    plan: [],
    trace: [],
    diff: [],
    error: null,
    degraded: false,
    waiting: false,
  });
  const clientRef = useRef<GatewayClient | null>(null);

  useEffect(() => {
    if (!threadId) return;
    const client = new GatewayClient(
      gatewayUrl ?? (process.env.NEXT_PUBLIC_GATEWAY_URL as string | undefined) ?? "http://localhost:8787",
      getToken ?? (async () => null),
    );
    clientRef.current = client;
    // fetch-based SSE (NOT EventSource — it cannot send an Authorization
    // header); openStream owns reconnect + Last-Event-ID.
    const close = client.openStream(threadId, (e) => setState((s) => applyEnvelope(s, e)));
    return () => {
      close();
      clientRef.current = null;
    };
  }, [threadId, getToken, gatewayUrl]);

  const ask = useCallback(
    async (message: string, specMode: "auto" | "force" | "off") => {
      if (!clientRef.current || !threadId) return;
      // Spec §6: a send while a turn is mid-flight queues as a steer.
      const steer = state.waiting ? { streamingBehavior: "steer" as const } : {};
      setState((s) => ({ ...s, waiting: true }));
      try {
        await clientRef.current.prompt(threadId, { message, specMode, ...steer });
      } finally {
        setState((s) => ({ ...s, waiting: false }));
      }
    },
    [threadId, state.waiting],
  );

  const stop = useCallback(async () => {
    if (!clientRef.current || !threadId) return;
    await clientRef.current.abortThread(threadId);
    setState((s) => ({ ...s, waiting: false }));
  }, [threadId]);

  const dismissError = useCallback(() => {
    setState((s) => ({ ...s, error: null }));
  }, []);

  const submitAnswers = useCallback(
    async (answers: Record<string, string>) => {
      if (!clientRef.current || !threadId) return;
      await clientRef.current.patchSpec(threadId, { kind: "answer", answers });
    },
    [threadId],
  );

  const editSpec = useCallback(
    async (field: "goal" | "filesAffected" | "plan" | "risks", value: string | string[]) => {
      if (!clientRef.current || !threadId) return;
      await clientRef.current.patchSpec(threadId, { kind: "edit", field, value });
    },
    [threadId],
  );

  const approve = useCallback(async () => {
    if (!clientRef.current || !threadId) return;
    await clientRef.current.approveSpec(threadId);
  }, [threadId]);

  const abandon = useCallback(async () => {
    if (!clientRef.current || !threadId) return;
    await clientRef.current.abandonThread(threadId);
  }, [threadId]);

  const retry = useCallback(async () => {
    if (!clientRef.current || !threadId) return;
    await clientRef.current.retryThread(threadId);
  }, [threadId]);

  return { ...state, ask, submitAnswers, editSpec, approve, abandon, retry, stop, dismissError };
}

function applyEnvelope(s: ThreadState, e: EventEnvelope): ThreadState {
  switch (e.kind) {
    case "spec_status":
      return { ...s, status: e.payload.status };
    case "spec_question":
      return { ...s, questions: e.payload.questions };
    case "spec_draft":
      return { ...s, draft: e.payload.draft, plan: e.payload.draft.plan };
    case "text_delta":
      return { ...s, trace: [...s.trace, e.payload.delta] };
    case "diff":
      return { ...s, diff: e.payload.files };
    case "error":
      return { ...s, error: e.payload.message };
    case "session_state":
      // Spec §10: degraded means the host died mid-turn; the next prompt
      // respawns it. streaming/idle drive the waiting flag for Stop + steer.
      return {
        ...s,
        degraded: e.payload.state === "degraded",
        waiting: e.payload.state === "streaming",
      };
    default:
      return s;
  }
}
