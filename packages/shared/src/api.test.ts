import { describe, expect, it } from "vitest";
import {
  CreateConversationBody,
  Conversation,
  PromptBody,
  ROUTES,
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
