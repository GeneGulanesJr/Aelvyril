import { describe, expect, it, vi } from "vitest";
import { EventBus } from "./bus.js";
import { Store } from "./store.js";

const ts = "2026-09-22T12:00:00.000Z";

function makeBus() {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  return { store, bus };
}

describe("EventBus", () => {
  it("persists then fans out with assigned seq", () => {
    const { store, bus } = makeBus();
    const conv = store.createConversation({ namespace: "platform" });
    const seen: number[] = [];
    bus.subscribe(conv.id, (e) => seen.push(e.seq));
    bus.publish({ conversationId: conv.id, ts, kind: "text_delta", payload: { delta: "x" } });
    expect(seen).toEqual([0]);
  });

  it("unsubscribed listeners get nothing", () => {
    const { store, bus } = makeBus();
    const conv = store.createConversation({ namespace: "platform" });
    const fn = vi.fn();
    const off = bus.subscribe(conv.id, fn);
    off();
    bus.publish({ conversationId: conv.id, ts, kind: "text_delta", payload: { delta: "x" } });
    expect(fn).not.toHaveBeenCalled();
  });

  it("replay returns persisted events after the given seq", () => {
    const { store, bus } = makeBus();
    const conv = store.createConversation({ namespace: "platform" });
    bus.publish({ conversationId: conv.id, ts, kind: "text_delta", payload: { delta: "a" } });
    bus.publish({ conversationId: conv.id, ts, kind: "text_delta", payload: { delta: "b" } });
    expect(bus.replay(conv.id, 0)).toHaveLength(1);
  });
});
