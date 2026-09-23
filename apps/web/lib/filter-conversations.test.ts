import { describe, expect, it } from "vitest";
import type { Conversation } from "@aelvyril/shared";
import { filterConversations } from "./filter-conversations.js";

function make(overrides: Partial<Conversation> & { id: string; title?: string | null }): Conversation {
  return {
    id: overrides.id,
    title: overrides.title ?? null,
    workspace: overrides.workspace ?? null,
    state: overrides.state ?? "idle",
    createdAt: overrides.createdAt ?? "2026-09-22T12:00:00.000Z",
  };
}

describe("filterConversations", () => {
  const convs: Conversation[] = [
    make({ id: "conv_1", title: "Fix login bug" }),
    make({ id: "conv_2", title: "Add search filter" }),
    make({ id: "conv_3", title: null }),
    make({ id: "conv_4", title: "Refactor the auth flow" }),
  ];

  it("returns all conversations for an empty query", () => {
    expect(filterConversations(convs, "").map((c) => c.id)).toEqual(["conv_1", "conv_2", "conv_3", "conv_4"]);
  });

  it("matches titles case-insensitively", () => {
    expect(filterConversations(convs, "auth").map((c) => c.id)).toEqual(["conv_4"]);
    expect(filterConversations(convs, "AUTH").map((c) => c.id)).toEqual(["conv_4"]);
  });

  it("matches substrings, not just prefixes", () => {
    expect(filterConversations(convs, "filter").map((c) => c.id)).toEqual(["conv_2"]);
  });

  it("returns empty array when no titles match", () => {
    expect(filterConversations(convs, "kubernetes")).toEqual([]);
  });

  it("treats null titles as unmatchable but still surfaces them when query is empty", () => {
    expect(filterConversations(convs, "").some((c) => c.id === "conv_3")).toBe(true);
    expect(filterConversations(convs, "anything").some((c) => c.id === "conv_3")).toBe(false);
  });
});