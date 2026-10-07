import { describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "@aelvyril/shared";
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

  it("rejects an invalid envelope without storing or fanning out (#85)", () => {
    const { store, bus } = makeBus();
    const conv = store.createConversation({ namespace: "platform" });
    const fn = vi.fn();
    bus.subscribe(conv.id, fn);
    // kind not in the union
    const badKind = {
      conversationId: conv.id,
      ts,
      kind: "custom_env_echo\r\nX",
      payload: {},
    } as unknown as Omit<EventEnvelope, "seq">;
    expect(bus.publish(badKind)).toBeNull();
    // payload fails the per-kind schema
    expect(
      bus.publish({ conversationId: conv.id, ts, kind: "user_message", payload: { text: "" } }),
    ).toBeNull();
    expect(fn).not.toHaveBeenCalled();
    expect(store.getEventsSince(conv.id, -1)).toHaveLength(0);
  });

  // Review P3: a rejected envelope used to vanish silently — now it warns
  // and bumps a counter so producer bugs are visible.
  it("warns and counts rejected envelopes (review P3)", () => {
    const { store, bus } = makeBus();
    const conv = store.createConversation({ namespace: "platform" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const before = bus.rejectedEnvelopes();
      expect(
        bus.publish({ conversationId: conv.id, ts, kind: "user_message", payload: { text: "" } }),
      ).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("[bus] rejected invalid envelope");
      expect(bus.rejectedEnvelopes()).toBe(before + 1);
    } finally {
      warn.mockRestore();
    }
  });

  it("accepts the wrapped custom kind (#85)", () => {
    const { store, bus } = makeBus();
    const conv = store.createConversation({ namespace: "platform" });
    const full = bus.publish({
      conversationId: conv.id,
      ts,
      kind: "custom",
      payload: { type: "custom_env_echo", data: { LAPIS_PROJECT_KEY: "user:u" } },
    });
    expect(full?.kind).toBe("custom");
    expect(store.getEventsSince(conv.id, -1)).toHaveLength(1);
  });
});
