import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EventBus } from "./bus.js";
import { Store } from "./store.js";
import { Supervisor } from "./supervisor.js";
import type { EventEnvelope } from "@aelvyril/shared";

const fakePi = fileURLToPath(new URL("../fixtures/fake-pi.mjs", import.meta.url));

function makeSupervisor() {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const supervisor = new Supervisor({
    bus,
    store,
    spawnChild: (conversationId, extraEnv) => {
      void conversationId;
      void extraEnv;
      return spawn(process.execPath, [fakePi]);
    },
    idleMs: 60_000,
  });
  return { store, bus, supervisor };
}

describe("Supervisor", () => {
  let s: Supervisor | undefined;
  afterEach(() => s?.disposeAll());

  it("prompt streams normalized envelopes and ends idle", async () => {
    const { store, bus, supervisor } = makeSupervisor();
    s = supervisor;
    const conv = store.createConversation({ namespace: "platform" });
    const seen: EventEnvelope[] = [];
    const done = new Promise<void>((resolve) => {
      bus.subscribe(conv.id, (e) => {
        seen.push(e);
        if (e.kind !== "session_state") return;
        // The zod-inferred union is not discriminated under tsc (kind stays
        // the full EnvelopeKind union), so narrow the payload explicitly.
        const payload = e.payload as { state: string };
        if (payload.state === "idle") resolve();
      });
    });
    const accepted = await supervisor.prompt(conv.id, "hi");
    expect(accepted).toBe(true);
    await done;

    const kinds = seen.map((e) => e.kind);
    expect(kinds[0]).toBe("session_state"); // streaming
    expect(kinds).toContain("text_delta");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    const seqs = seen.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(store.getConversation(conv.id, "platform")?.state).toBe("idle");
    const deltas = seen
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.payload as { delta: string }).delta)
      .join("");
    expect(deltas).toBe("Hello, world!");
  });

  it("marks degraded when the child dies, then recovers on next prompt", async () => {
    const { store, supervisor } = makeSupervisor();
    s = supervisor;
    const conv = store.createConversation({ namespace: "platform" });
    await supervisor.prompt(conv.id, "hi"); // accepted; turn settles async
    await vi.waitFor(() => {
      expect(store.getConversation(conv.id, "platform")?.state).toBe("idle");
    });
    supervisor.killChild(conv.id); // simulate crash
    await vi.waitFor(() => {
      expect(store.getConversation(conv.id, "platform")?.state).toBe("degraded");
    });
    const ok = await supervisor.prompt(conv.id, "again"); // respawn
    expect(ok).toBe(true);
    await vi.waitFor(() => {
      expect(store.getConversation(conv.id, "platform")?.state).toBe("idle");
    });
  });

  it("replays nothing for a fresh conversation", () => {
    const { bus, store } = makeSupervisor();
    const conv = store.createConversation({ namespace: "platform" });
    expect(bus.replay(conv.id, -1)).toEqual([]);
  });
});
