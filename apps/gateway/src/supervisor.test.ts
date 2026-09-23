import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  let tmpDirs: string[] = [];
  afterEach(() => {
    s?.disposeAll();
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpDirs = [];
  });

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

  // Spec §6 + §10: workspace plumbs through to spawn cwd; respawn after a
  // crash reuses the same cwd so pi finds its prior session file on disk.
  it("spawns session host with conversation.workspace as cwd, and reuses it after kill", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aelvyril-ws-"));
    tmpDirs.push(dir);
    const store = new Store(":memory:");
    const conv = store.createConversation({ workspace: dir, namespace: "platform" });
    const spawnCalls: Array<{ cwd: string | undefined; env: Record<string, string> }> = [];
    const bus = new EventBus(store);
    const supervisor = new Supervisor({
      bus,
      store,
      spawnChild: (_cid, extraEnv, cwd) => {
        spawnCalls.push({ cwd: cwd ?? undefined, env: { ...extraEnv } });
        return spawn(process.execPath, [fakePi], { cwd, env: { ...process.env, ...extraEnv } });
      },
      idleMs: 60_000,
    });
    s = supervisor;

    expect(await supervisor.prompt(conv.id, "hi", undefined, { LAPIS_PROJECT_KEY: "platform" })).toBe(true);
    await vi.waitFor(() => {
      expect(store.getConversation(conv.id, "platform")?.state).toBe("idle");
    });
    supervisor.killChild(conv.id);
    await vi.waitFor(() => {
      expect(store.getConversation(conv.id, "platform")?.state).toBe("degraded");
    });
    expect(await supervisor.prompt(conv.id, "again", undefined, { LAPIS_PROJECT_KEY: "platform" })).toBe(true);
    await vi.waitFor(() => {
      expect(store.getConversation(conv.id, "platform")?.state).toBe("idle");
    });

    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]!.cwd).toBe(dir);
    expect(spawnCalls[1]!.cwd).toBe(dir); // resume: same cwd, pi reuses session file
    // LAPIS_PROJECT_KEY plumbed through unchanged on both spawns.
    expect(spawnCalls[0]!.env.LAPIS_PROJECT_KEY).toBe("platform");
    expect(spawnCalls[1]!.env.LAPIS_PROJECT_KEY).toBe("platform");
  });

  it("falls back to no cwd when the conversation has no workspace", async () => {
    const store = new Store(":memory:");
    const conv = store.createConversation({ namespace: "platform" }); // no workspace
    const spawnCalls: Array<{ cwd: string | undefined }> = [];
    const supervisor = new Supervisor({
      bus: new EventBus(store),
      store,
      spawnChild: (_cid, _extraEnv, cwd) => {
        spawnCalls.push({ cwd: cwd ?? undefined });
        return spawn(process.execPath, [fakePi]);
      },
      idleMs: 60_000,
    });
    s = supervisor;
    await supervisor.prompt(conv.id, "hi");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.cwd).toBeUndefined();
  });
});
