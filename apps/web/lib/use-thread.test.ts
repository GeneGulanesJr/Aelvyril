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
    expect(inst.openStream).toHaveBeenCalledWith("t1", expect.any(Function));
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
    });
    expect(inst.patchSpec).toHaveBeenNthCalledWith(1, "t1", { kind: "answer", answers: { q1: "a" } });
    expect(inst.patchSpec).toHaveBeenNthCalledWith(2, "t1", { kind: "edit", field: "goal", value: "new goal" });
    expect(inst.approveSpec).toHaveBeenCalledWith("t1");
    expect(inst.abandonThread).toHaveBeenCalledWith("t1");
    expect(inst.retryThread).toHaveBeenCalledWith("t1");
  });
});
