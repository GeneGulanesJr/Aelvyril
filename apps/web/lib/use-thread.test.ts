// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useThread } from "./use-thread.js";
import type { EventEnvelope } from "@aelvyril/shared";

const instances: Array<{
  openStream: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  patchSpec: ReturnType<typeof vi.fn>;
  approveSpec: ReturnType<typeof vi.fn>;
  abandonThread: ReturnType<typeof vi.fn>;
  retryThread: ReturnType<typeof vi.fn>;
  mergeThread: ReturnType<typeof vi.fn>;
  abortThread: ReturnType<typeof vi.fn>;
  deleteThread: ReturnType<typeof vi.fn>;
  onEnvelope: ((e: EventEnvelope) => void) | null;
}> = [];

vi.mock("./api.js", () => ({
  GatewayClient: vi.fn().mockImplementation(() => {
    const inst = {
      openStream: vi.fn((_id: string, onEnvelope: (e: EventEnvelope) => void) => {
        inst.onEnvelope = onEnvelope;
        return () => {};
      }),
      prompt: vi.fn().mockResolvedValue(undefined),
      patchSpec: vi.fn().mockResolvedValue(undefined),
      approveSpec: vi.fn().mockResolvedValue(undefined),
      abandonThread: vi.fn().mockResolvedValue(undefined),
      retryThread: vi.fn().mockResolvedValue(undefined),
      mergeThread: vi.fn().mockResolvedValue(undefined),
      abortThread: vi.fn().mockResolvedValue(undefined),
      deleteThread: vi.fn().mockResolvedValue(undefined),
      onEnvelope: null as ((e: EventEnvelope) => void) | null,
    };
    instances.push(inst);
    return inst;
  }),
}));

function env(kind: string, payload: unknown, seq = 0): EventEnvelope {
  return { seq, conversationId: "t1", ts: "2026-09-23T00:00:00.000Z", kind, payload } as unknown as EventEnvelope;
}

async function renderThread(threadId: string | null = "t1") {
  const getToken = vi.fn().mockResolvedValue("tok");
  const h = renderHook(() => useThread(threadId, { getToken }));
  // useEffect runs synchronously in RTL; wait a microtask for the async client setup.
  await act(async () => {});
  return { ...h, inst: instances[instances.length - 1]! };
}

describe("useThread", () => {
  it("exposes thread state + actions", async () => {
    const { result } = await renderThread();
    expect(result.current.status).toBe("draft");
    expect(typeof result.current.ask).toBe("function");
    expect(typeof result.current.submitAnswers).toBe("function");
    expect(typeof result.current.approve).toBe("function");
  });

  it("opens the event stream for a live thread", async () => {
    const { inst } = await renderThread("t1");
    // (id, onEnvelope, signal=undefined, onLost) — onLost surfaces terminal
    // stream loss in the error banner (#85).
    expect(inst.openStream).toHaveBeenCalledWith(
      "t1",
      expect.any(Function),
      undefined,
      expect.any(Function),
    );
  });

  it("does not open a stream when threadId is null (new thread)", async () => {
    const before = instances.length;
    await renderThread(null);
    expect(instances.length).toBe(before); // no client created for null id
  });

  it("ask forwards message + specMode to client.prompt", async () => {
    const { result, inst } = await renderThread();
    await act(async () => {
      await result.current.ask("add RBAC", "force");
    });
    expect(inst.prompt).toHaveBeenCalledWith("t1", { message: "add RBAC", specMode: "force" });
  });

  it("reduces spec envelopes into state", async () => {
    const { result, inst } = await renderThread();
    // Before a live spec_status arrives, the initial status must not claim
    // to be live (#83: the header shows the thread-list snapshot instead).
    expect(result.current.statusLive).toBe(false);
    await act(async () => {
      inst.onEnvelope!(env("spec_status", { status: "spec'ing" }, 0));
      inst.onEnvelope!(
        env("spec_question", { questions: [{ id: "q1", prompt: "?", kind: "text" }] }, 1),
      );
      inst.onEnvelope!(
        env(
          "spec_draft",
          {
            draft: {
              goal: "g",
              filesAffected: [],
              plan: ["step1"],
              risks: [],
              questions: [],
              answers: {},
            },
          },
          2,
        ),
      );
      inst.onEnvelope!(env("diff", { files: [{ path: "a.ts", patch: "@@" }] }, 3));
    });
    expect(result.current.status).toBe("spec'ing");
    expect(result.current.statusLive).toBe(true);
    expect(result.current.questions).toHaveLength(1);
    expect(result.current.draft?.goal).toBe("g");
    expect(result.current.plan).toEqual(["step1"]);
    expect(result.current.diff).toEqual([{ path: "a.ts", patch: "@@" }]);
  });

  it("submitAnswers/approve/abandon/retry call the thread routes", async () => {
    const { result, inst } = await renderThread();
    await act(async () => {
      await result.current.submitAnswers({ q1: "a" });
      await result.current.editSpec("goal", "new goal");
      await result.current.approve();
      await result.current.abandon();
      await result.current.retry();
      await result.current.merge();
    });
    expect(inst.patchSpec).toHaveBeenNthCalledWith(1, "t1", { kind: "answer", answers: { q1: "a" } });
    expect(inst.patchSpec).toHaveBeenNthCalledWith(2, "t1", { kind: "edit", field: "goal", value: "new goal" });
    expect(inst.approveSpec).toHaveBeenCalledWith("t1");
    expect(inst.abandonThread).toHaveBeenCalledWith("t1");
    expect(inst.retryThread).toHaveBeenCalledWith("t1");
    // #80: merge accepts the reviewed diff.
    expect(inst.mergeThread).toHaveBeenCalledWith("t1");
  });

  it("ask mid-flight steers; idle session clears waiting", async () => {
    const { result, inst } = await renderThread();
    await act(async () => {
      await result.current.ask("first", "auto");
    });
    expect(inst.prompt).toHaveBeenCalledWith("t1", { message: "first", specMode: "auto" });
    // Simulate the agent starting to stream: waiting flips on.
    await act(async () => {
      inst.onEnvelope!(env("session_state", { state: "streaming" }, 0));
    });
    expect(result.current.waiting).toBe(true);
    // A second ask while waiting queues as a steer.
    await act(async () => {
      await result.current.ask("second", "auto");
    });
    expect(inst.prompt).toHaveBeenLastCalledWith("t1", {
      message: "second",
      specMode: "auto",
      streamingBehavior: "steer",
    });
    // Agent settles: waiting clears.
    await act(async () => {
      inst.onEnvelope!(env("session_state", { state: "idle" }, 1));
    });
    expect(result.current.waiting).toBe(false);
  });

  it("degraded session sets the flag; stop aborts and clears waiting", async () => {
    const { result, inst } = await renderThread();
    await act(async () => {
      inst.onEnvelope!(env("session_state", { state: "degraded" }, 0));
    });
    expect(result.current.degraded).toBe(true);
    expect(result.current.waiting).toBe(false);
    await act(async () => {
      await result.current.ask("retry", "auto");
    });
    await act(async () => {
      await result.current.stop();
    });
    expect(inst.abortThread).toHaveBeenCalledWith("t1");
    expect(result.current.waiting).toBe(false);
  });

  it("blocked session_state sets the escalation reason; idle clears it (#84)", async () => {
    const { result, inst } = await renderThread();
    await act(async () => {
      inst.onEnvelope!(env("session_state", { state: "blocked", reason: "capped" }, 0));
    });
    expect(result.current.blocked).toBe("capped");
    expect(result.current.waiting).toBe(false);
    await act(async () => {
      inst.onEnvelope!(env("session_state", { state: "idle" }, 1));
    });
    expect(result.current.blocked).toBeNull();
  });

  it("a gated stop sets the blocked reason to gated (#81)", async () => {
    const { result, inst } = await renderThread();
    await act(async () => {
      inst.onEnvelope!(env("session_state", { state: "blocked", reason: "gated" }, 0));
    });
    expect(result.current.blocked).toBe("gated");
  });

  it("error envelopes set a dismissable error", async () => {
    const { result, inst } = await renderThread();
    await act(async () => {
      inst.onEnvelope!(env("error", { message: "boom" }, 0));
    });
    expect(result.current.error).toBe("boom");
    await act(async () => {
      result.current.dismissError();
    });
    expect(result.current.error).toBeNull();
  });

  it("usage envelopes accumulate the cost/token signal (#84)", async () => {
    const { result, inst } = await renderThread();
    expect(result.current.usage).toBeNull();
    await act(async () => {
      inst.onEnvelope!(
        env(
          "usage",
          { tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 }, cost: 0.0042 },
          0,
        ),
      );
    });
    expect(result.current.usage).toEqual({
      tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
      cost: 0.0042,
    });
  });
});
