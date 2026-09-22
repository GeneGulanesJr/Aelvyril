import { describe, expect, it } from "vitest";
import { EventEnvelope, EnvelopeKind } from "./envelope.js";

const base = {
  seq: 1,
  conversationId: "conv_123",
  ts: "2026-09-22T12:00:00.000Z",
};

describe("EventEnvelope", () => {
  it("accepts a valid text_delta envelope", () => {
    const parsed = EventEnvelope.parse({
      ...base,
      kind: "text_delta",
      payload: { delta: "hello" },
    });
    expect(parsed.payload).toEqual({ delta: "hello" });
  });

  it("accepts a valid tool_call envelope", () => {
    const parsed = EventEnvelope.parse({
      ...base,
      kind: "tool_call",
      payload: { toolCallId: "c1", toolName: "bash", args: { cmd: "ls" } },
    });
    expect(parsed.payload).toEqual({
      toolCallId: "c1",
      toolName: "bash",
      args: { cmd: "ls" },
    });
  });

  it("rejects an unknown kind", () => {
    expect(
      EventEnvelope.safeParse({ ...base, kind: "nope", payload: {} }).success,
    ).toBe(false);
  });

  it("rejects negative seq", () => {
    expect(
      EventEnvelope.safeParse({
        seq: -1,
        conversationId: "conv_123",
        ts: "2026-09-22T12:00:00.000Z",
        kind: "text_delta",
        payload: { delta: "x" },
      }).success,
    ).toBe(false);
  });

  it("covers every EnvelopeKind with a payload schema", () => {
    expect(EnvelopeKind.options).toEqual([
      "text_delta",
      "tool_call",
      "tool_result",
      "subagent_spawn",
      "sandbox_exec",
      "sandbox_promote",
      "laya_verdict",
      "session_state",
      "error",
    ]);
  });
});
