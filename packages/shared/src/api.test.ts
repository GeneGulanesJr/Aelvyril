import { describe, expect, it } from "vitest";
import {
  CreateConversationBody,
  Conversation,
  PromptBody,
  ROUTES,
  SpecDraft,
  SpecQuestion,
  Thread,
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
    const q = SpecQuestion.parse({ id: "q1", prompt: "What roles?", kind: "text" });
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

  it("rejects a select question without options", () => {
    expect(() => SpecQuestion.parse({ id: "q3", prompt: "Auth?", kind: "select" })).toThrow();
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
});

describe("ThreadStatus", () => {
  it("accepts all 6 statuses", () => {
    for (const s of ["draft", "spec'ing", "running", "reviewed", "merged", "abandoned"] as const) {
      expect(ThreadStatus.parse(s)).toBe(s);
    }
  });
  it("rejects unknown status", () => {
    expect(() => ThreadStatus.parse("bogus")).toThrow();
  });
});

describe("Thread", () => {
  it("extends Conversation with status + spec fields", () => {
    const t = Thread.parse({
      id: "conv_1",
      title: "t",
      workspace: null,
      state: "idle",
      createdAt: "2026-09-22T12:00:00.000Z",
      status: "spec'ing",
      specDraft: null,
      specQuestions: [{ id: "q1", prompt: "Roles?", kind: "text" }],
      specAnswers: { q1: "admin" },
    });
    expect(t.status).toBe("spec'ing");
    expect(t.specQuestions).toHaveLength(1);
  });
});

describe("PromptBody specMode", () => {
  it("defaults specMode to auto", () => {
    expect(PromptBody.parse({ message: "hi" }).specMode).toBe("auto");
  });
  it("accepts explicit specMode", () => {
    expect(PromptBody.parse({ message: "hi", specMode: "force" }).specMode).toBe("force");
  });
  it("rejects unknown specMode", () => {
    expect(PromptBody.safeParse({ message: "hi", specMode: "maybe" }).success).toBe(false);
  });
});
