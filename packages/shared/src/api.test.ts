import { describe, expect, it } from "vitest";
import {
  Conversation,
  CreateConversationBody,
  PatchSpecBody,
  PromptBody,
  ROUTES,
  SpecDraft,
  SpecQuestion,
  ThreadStatus,
} from "./api.js";

describe("ROUTES", () => {
  it("defines the v1 surface", () => {
    expect(ROUTES.conversations).toBe("/v1/conversations");
    expect(ROUTES.conversationEvents(":id")).toBe(
      "/v1/conversations/:id/events",
    );
    expect(ROUTES.conversationPrompt(":id")).toBe(
      "/v1/conversations/:id/prompt",
    );
    expect(ROUTES.conversationAbort(":id")).toBe(
      "/v1/conversations/:id/abort",
    );
  });
});

describe("CreateConversationBody", () => {
  it("accepts minimal body", () => {
    expect(CreateConversationBody.parse({})).toEqual({});
  });
  it("accepts workspace", () => {
    expect(
      CreateConversationBody.parse({ title: "t", workspace: "LaPis" }),
    ).toEqual({ title: "t", workspace: "LaPis" });
  });
});

describe("PromptBody", () => {
  it("accepts a message", () => {
    expect(PromptBody.parse({ message: "hi" }).message).toBe("hi");
  });
  it("rejects empty message", () => {
    expect(PromptBody.safeParse({ message: "" }).success).toBe(false);
  });
  it("rejects messages over 1MB", () => {
    expect(PromptBody.safeParse({ message: "x".repeat(1_000_001) }).success).toBe(
      false,
    );
  });
});

describe("Conversation", () => {
  it("parses a DTO", () => {
    expect(
      Conversation.parse({
        id: "conv_1",
        title: null,
        workspace: null,
        state: "idle",
        createdAt: "2026-09-22T12:00:00.000Z",
      }).state,
    ).toBe("idle");
  });
});

describe("SpecQuestion", () => {
  it("parses a text question", () => {
    const q = SpecQuestion.parse({
      id: "q1",
      prompt: "What roles?",
      kind: "text",
    });
    expect(q.id).toBe("q1");
    expect(q.kind).toBe("text");
  });
  it("parses a select question with options", () => {
    const q = SpecQuestion.parse({
      id: "q2",
      prompt: "Auth?",
      kind: "select",
      options: ["existing", "new"],
    });
    expect(q.options).toEqual(["existing", "new"]);
  });
  it("parses a multiselect question", () => {
    const q = SpecQuestion.parse({
      id: "q3",
      prompt: "Pick outputs?",
      kind: "multiselect",
      options: ["plan", "diff", "trace"],
    });
    expect(q.kind).toBe("multiselect");
  });
  it("rejects empty id or prompt", () => {
    expect(SpecQuestion.safeParse({ id: "", prompt: "x", kind: "text" }).success).toBe(false);
    expect(SpecQuestion.safeParse({ id: "q1", prompt: "", kind: "text" }).success).toBe(false);
  });
});

describe("SpecDraft", () => {
  it("round-trips through JSON", () => {
    const d: SpecDraft = {
      goal: "add RBAC",
      filesAffected: ["apps/web/auth.ts"],
      plan: ["add role enum", "wire middleware"],
      risks: ["breaks existing users"],
      questions: [{ id: "q1", prompt: "Roles?", kind: "text" }],
      answers: { q1: "admin, editor" },
    };
    expect(SpecDraft.parse(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });
  it("accepts an empty draft", () => {
    const empty: SpecDraft = {
      goal: "",
      filesAffected: [],
      plan: [],
      risks: [],
      questions: [],
      answers: {},
    };
    expect(SpecDraft.parse(empty)).toEqual(empty);
  });
});

describe("ThreadStatus", () => {
  it("accepts all 6 statuses", () => {
    const expected = [
      "draft",
      "spec'ing",
      "running",
      "reviewed",
      "merged",
      "abandoned",
    ] as const;
    for (const s of expected) {
      expect(ThreadStatus.parse(s)).toBe(s);
    }
  });
  it("rejects unknown status", () => {
    expect(() => ThreadStatus.parse("bogus")).toThrow();
  });
});

describe("PatchSpecBody", () => {
  it("accepts an answer patch", () => {
    const parsed = PatchSpecBody.parse({
      kind: "answer",
      answers: { q1: "admin" },
    });
    expect(parsed.kind).toBe("answer");
    if (parsed.kind === "answer") {
      expect(parsed.answers).toEqual({ q1: "admin" });
    }
  });
  it("accepts an edit patch for a string field", () => {
    const parsed = PatchSpecBody.parse({
      kind: "edit",
      field: "goal",
      value: "ship RBAC v2",
    });
    expect(parsed.kind).toBe("edit");
    if (parsed.kind === "edit") {
      expect(parsed.field).toBe("goal");
    }
  });
  it("accepts an edit patch for an array field", () => {
    const parsed = PatchSpecBody.parse({
      kind: "edit",
      field: "plan",
      value: ["step 1", "step 2"],
    });
    expect(parsed.kind).toBe("edit");
  });
  it("rejects an unknown edit field", () => {
    expect(
      PatchSpecBody.safeParse({
        kind: "edit",
        field: "bogus",
        value: "x",
      }).success,
    ).toBe(false);
  });
});
