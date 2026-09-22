import { describe, expect, it } from "vitest";
import { Store } from "./store.js";

const ts = "2026-09-22T12:00:00.000Z";

describe("Store", () => {
  it("creates and lists conversations", () => {
    const store = new Store(":memory:");
    const conv = store.createConversation({ title: "t", workspace: "LaPis" });
    expect(conv.id).toMatch(/^conv_/);
    expect(conv.state).toBe("idle");
    const list = store.listConversations();
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe("t");
  });

  it("gets a conversation or null", () => {
    const store = new Store(":memory:");
    const conv = store.createConversation({});
    expect(store.getConversation(conv.id)?.id).toBe(conv.id);
    expect(store.getConversation("conv_nope")).toBeNull();
  });

  it("appends events with per-conversation monotonic seq", () => {
    const store = new Store(":memory:");
    const a = store.createConversation({});
    const b = store.createConversation({});
    const e1 = store.appendEvent({ conversationId: a.id, ts, kind: "text_delta", payload: { delta: "x" } });
    const e2 = store.appendEvent({ conversationId: a.id, ts, kind: "text_delta", payload: { delta: "y" } });
    const e3 = store.appendEvent({ conversationId: b.id, ts, kind: "session_state", payload: { state: "streaming" } });
    expect(e1.seq).toBe(0);
    expect(e2.seq).toBe(1);
    expect(e3.seq).toBe(0);
  });

  it("replays events since a seq", () => {
    const store = new Store(":memory:");
    const conv = store.createConversation({});
    store.appendEvent({ conversationId: conv.id, ts, kind: "session_state", payload: { state: "streaming" } });
    store.appendEvent({ conversationId: conv.id, ts, kind: "text_delta", payload: { delta: "a" } });
    store.appendEvent({ conversationId: conv.id, ts, kind: "text_delta", payload: { delta: "b" } });
    const replay = store.getEventsSince(conv.id, 0);
    expect(replay.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("updates conversation state", () => {
    const store = new Store(":memory:");
    const conv = store.createConversation({});
    store.setConversationState(conv.id, "streaming");
    expect(store.getConversation(conv.id)?.state).toBe("streaming");
  });
});
