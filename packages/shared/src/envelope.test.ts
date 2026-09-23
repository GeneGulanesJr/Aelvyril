import { describe, expect, it } from "vitest";
import {
  DiffEnvelope,
  EnvelopeKind,
  EventEnvelope,
  SpecDraftEnvelope,
  SpecQuestionEnvelope,
  SpecStatusEnvelope,
  parseEnvelope,
} from "./envelope.js";

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
    ]);
  });
});

describe("spec_question envelope", () => {
  it("parses with questions array payload", () => {
    const parsed = EventEnvelope.parse({
      ...base,
      kind: "spec_question",
      payload: {
        questions: [
          { id: "q1", prompt: "Roles?", kind: "text" },
          { id: "q2", prompt: "Auth?", kind: "select", options: ["existing", "new"] },
        ],
      },
    });
    expect(parsed.kind).toBe("spec_question");
    if (parsed.kind === "spec_question") {
      expect(parsed.payload.questions).toHaveLength(2);
      expect(parsed.payload.questions[0]?.id).toBe("q1");
    }
  });
});

describe("spec_draft envelope", () => {
  it("parses with a full draft payload", () => {
    const parsed = EventEnvelope.parse({
      ...base,
      kind: "spec_draft",
      payload: {
        draft: {
          goal: "add RBAC",
          filesAffected: ["apps/web/auth.ts"],
          plan: ["add role enum"],
          risks: [],
          questions: [{ id: "q1", prompt: "Roles?", kind: "text" }],
          answers: {},
        },
      },
    });
    expect(parsed.kind).toBe("spec_draft");
    if (parsed.kind === "spec_draft") {
      expect(parsed.payload.draft.goal).toBe("add RBAC");
    }
  });
});

describe("spec_status envelope", () => {
  it("parses for every ThreadStatus value", () => {
    for (const status of [
      "draft",
      "spec'ing",
      "running",
      "reviewed",
      "merged",
      "abandoned",
    ] as const) {
      const parsed = EventEnvelope.parse({
        ...base,
        kind: "spec_status",
        payload: { status },
      });
      if (parsed.kind !== "spec_status") throw new Error("kind mismatch");
      expect(parsed.payload.status).toBe(status);
    }
  });
});

describe("diff envelope", () => {
  it("parses with files array payload", () => {
    const parsed = EventEnvelope.parse({
      ...base,
      kind: "diff",
      payload: { files: [{ path: "a.ts", patch: "@@ -1 +1 @@" }] },
    });
    expect(parsed.kind).toBe("diff");
    if (parsed.kind === "diff") {
      expect(parsed.payload.files[0]?.path).toBe("a.ts");
    }
  });
});

describe("sub-envelope parsers", () => {
  it("SpecQuestionEnvelope parses in isolation", () => {
    expect(
      SpecQuestionEnvelope.safeParse({
        seq: 1,
        conversationId: "conv_x",
        ts: "2026-09-22T12:00:00.000Z",
        kind: "spec_question",
        payload: { questions: [{ id: "q1", prompt: "?", kind: "text" }] },
      }).success,
    ).toBe(true);
  });
  it("SpecDraftEnvelope parses in isolation", () => {
    expect(
      SpecDraftEnvelope.safeParse({
        seq: 1,
        conversationId: "conv_x",
        ts: "2026-09-22T12:00:00.000Z",
        kind: "spec_draft",
        payload: {
          draft: {
            goal: "",
            filesAffected: [],
            plan: [],
            risks: [],
            questions: [],
            answers: {},
          },
        },
      }).success,
    ).toBe(true);
  });
  it("SpecStatusEnvelope parses in isolation", () => {
    expect(
      SpecStatusEnvelope.safeParse({
        seq: 1,
        conversationId: "conv_x",
        ts: "2026-09-22T12:00:00.000Z",
        kind: "spec_status",
        payload: { status: "running" },
      }).success,
    ).toBe(true);
  });
  it("DiffEnvelope parses in isolation", () => {
    expect(
      DiffEnvelope.safeParse({
        seq: 1,
        conversationId: "conv_x",
        ts: "2026-09-22T12:00:00.000Z",
        kind: "diff",
        payload: { files: [{ path: "x", patch: "@@" }] },
      }).success,
    ).toBe(true);
  });
});

describe("parseEnvelope", () => {
  it("parses a spec_question envelope from raw JSON string", () => {
    const e = parseEnvelope(
      JSON.stringify({
        seq: 1,
        conversationId: "conv_x",
        ts: "2026-09-22T12:00:00.000Z",
        kind: "spec_question",
        payload: { questions: [{ id: "q1", prompt: "Roles?", kind: "text" }] },
      }),
    );
    expect(e?.kind).toBe("spec_question");
  });

  it("parses a spec_draft envelope from raw JSON string", () => {
    const e = parseEnvelope(
      JSON.stringify({
        seq: 1,
        conversationId: "conv_x",
        ts: "2026-09-22T12:00:00.000Z",
        kind: "spec_draft",
        payload: {
          draft: {
            goal: "x",
            filesAffected: [],
            plan: [],
            risks: [],
            questions: [],
            answers: {},
          },
        },
      }),
    );
    expect(e?.kind).toBe("spec_draft");
  });

  it("parses a spec_status envelope from raw JSON string", () => {
    const e = parseEnvelope(
      JSON.stringify({
        seq: 1,
        conversationId: "conv_x",
        ts: "2026-09-22T12:00:00.000Z",
        kind: "spec_status",
        payload: { status: "running" },
      }),
    );
    expect(e?.kind).toBe("spec_status");
  });

  it("parses a diff envelope from raw JSON string", () => {
    const e = parseEnvelope(
      JSON.stringify({
        seq: 1,
        conversationId: "conv_x",
        ts: "2026-09-22T12:00:00.000Z",
        kind: "diff",
        payload: { files: [{ path: "a.ts", patch: "@@ ..." }] },
      }),
    );
    expect(e?.kind).toBe("diff");
  });

  it("returns null for unknown kind", () => {
    expect(
      parseEnvelope(
        JSON.stringify({
          seq: 1,
          conversationId: "conv_x",
          ts: "2026-09-22T12:00:00.000Z",
          kind: "bogus",
          payload: {},
        }),
      ),
    ).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseEnvelope("not json")).toBeNull();
    expect(parseEnvelope("")).toBeNull();
  });

  it("returns null for a valid JSON object that fails schema validation", () => {
    expect(
      parseEnvelope(JSON.stringify({ hello: "world" })),
    ).toBeNull();
  });
});
