import { describe, expect, it } from "vitest";
import { EnvelopeKind, EventEnvelope } from "./envelope.js";

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

  it("accepts a valid user_message envelope", () => {
    const parsed = EventEnvelope.parse({
      ...base,
      kind: "user_message",
      payload: { text: "fix the login bug" },
    });
    expect(parsed.payload).toEqual({ text: "fix the login bug" });
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
      "user_message",
      "session_state",
      "error",
      "spec_question",
      "spec_draft",
      "spec_status",
      "diff",
      "custom",
      "usage",
    ]);
  });

  it("accepts a custom envelope with a safe type (#85)", () => {
    const parsed = EventEnvelope.parse({
      ...base,
      kind: "custom",
      payload: { type: "custom_env_echo", data: { LAPIS_PROJECT_KEY: "user:u" } },
    });
    expect(parsed.payload).toEqual({
      type: "custom_env_echo",
      data: { LAPIS_PROJECT_KEY: "user:u" },
    });
  });

  it("rejects a custom envelope whose type breaks SSE framing (#85)", () => {
    expect(
      EventEnvelope.safeParse({
        ...base,
        kind: "custom",
        payload: { type: "evil\nX", data: {} },
      }).success,
    ).toBe(false);
  });

  it("accepts a usage envelope (#84)", () => {
    const parsed = EventEnvelope.parse({
      ...base,
      kind: "usage",
      payload: {
        tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
        cost: 0.0042,
      },
    });
    expect(parsed.payload).toEqual({
      tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
      cost: 0.0042,
    });
  });

  it("rejects a usage envelope with negative tokens (#84)", () => {
    expect(
      EventEnvelope.safeParse({
        ...base,
        kind: "usage",
        payload: {
          tokens: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
        },
      }).success,
    ).toBe(false);
  });
});

describe("spec envelopes", () => {
  it("accepts a spec_question envelope", () => {
    const parsed = EventEnvelope.parse({
      ...base,
      kind: "spec_question",
      payload: { questions: [{ id: "q1", prompt: "Roles?", kind: "text" }] },
    });
    expect(parsed.payload).toEqual({
      questions: [{ id: "q1", prompt: "Roles?", kind: "text" }],
    });
  });

  it("accepts a spec_draft envelope", () => {
    const draft = {
      goal: "x",
      filesAffected: [],
      plan: [],
      risks: [],
      questions: [],
      answers: {},
    };
    const parsed = EventEnvelope.parse({
      ...base,
      kind: "spec_draft",
      payload: { draft },
    });
    expect(parsed.payload).toEqual({ draft });
  });

  it("accepts a spec_status envelope", () => {
    const parsed = EventEnvelope.parse({
      ...base,
      kind: "spec_status",
      payload: { status: "running" },
    });
    expect(parsed.payload).toEqual({ status: "running" });
  });

  it("rejects a spec_status envelope with unknown status", () => {
    expect(
      EventEnvelope.safeParse({
        ...base,
        kind: "spec_status",
        payload: { status: "bogus" },
      }).success,
    ).toBe(false);
  });

  it("accepts a diff envelope", () => {
    const parsed = EventEnvelope.parse({
      ...base,
      kind: "diff",
      payload: { files: [{ path: "a.ts", patch: "@@ ..." }] },
    });
    expect(parsed.payload).toEqual({ files: [{ path: "a.ts", patch: "@@ ..." }] });
  });
});
