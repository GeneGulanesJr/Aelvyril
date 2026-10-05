import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "./bus.js";
import { Store } from "./store.js";
import { Supervisor, type SupervisorOptions } from "./supervisor.js";
import type { EventEnvelope } from "@aelvyril/shared";

const fakePi = fileURLToPath(new URL("../fixtures/fake-pi.mjs", import.meta.url));

function makeSupervisor(opts: Partial<SupervisorOptions> = {}) {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const children: ChildProcess[] = [];
  const supervisor = new Supervisor({
    bus,
    store,
    spawnChild: (conversationId, extraEnv) => {
      void conversationId;
      void extraEnv;
      const child = spawn(process.execPath, [fakePi]);
      children.push(child);
      return child;
    },
    idleMs: 60_000,
    ...opts,
  });
  return { store, bus, supervisor, children };
}

type FakeChild = Omit<
  ChildProcess,
  "stdin" | "stdout" | "stderr" | "kill" | "exitCode" | "signalCode"
> & {
  stdin: EventEmitter & { write: (buf: string) => boolean };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: NodeJS.Signals) => boolean;
  kills: string[];
  // ChildProcess types these readonly; the fake drives them on SIGKILL.
  exitCode: number | null;
  signalCode: string | null;
};

/**
 * A ChildProcess-shaped EventEmitter speaking just enough of the pi
 * protocol for RpcClient + Supervisor: answers every command success, then
 * agent_settled for prompts. SIGTERM/SIGKILL are recorded in `kills`;
 * SIGTERM is IGNORED (the escalation case #77) while SIGKILL emits exit.
 */
function fakeRpcChild(): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild;
  child.kills = [];
  // A live child has both null; the supervisor checks !== null to detect
  // "already exited" — undefined would be misread as dead.
  child.exitCode = null;
  child.signalCode = null;
  const stdin = new EventEmitter() as FakeChild["stdin"];
  stdin.write = (buf: string) => {
    const cmd = JSON.parse(buf) as { id?: string; type: string };
    setImmediate(() => {
      if (typeof cmd.id === "string") {
        child.stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: true }) + "\n",
          ),
        );
      }
      if (cmd.type === "prompt") {
        child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "agent_settled" }) + "\n"));
      }
    });
    return true;
  };
  child.stdin = stdin;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal: NodeJS.Signals = "SIGTERM") => {
    child.kills.push(String(signal));
    if (String(signal) === "SIGKILL") {
      child.signalCode = "SIGKILL";
      setImmediate(() => child.emit("exit", null, "SIGKILL"));
    }
    return true;
  };
  return child;
}

function makeFakeSupervisor(opts: Partial<SupervisorOptions> = {}) {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const children: FakeChild[] = [];
  const supervisor = new Supervisor({
    bus,
    store,
    spawnChild: () => {
      const child = fakeRpcChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    idleMs: 60_000,
    ...opts,
  });
  return { store, bus, supervisor, children };
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
    // #84: usage is harvested at settle (fake-pi's get_session_stats) and
    // lands both on the bus and in the store.
    await vi.waitFor(() => {
      expect(seen.some((e) => e.kind === "usage")).toBe(true);
    });
    const usageEnv = seen.find((e) => e.kind === "usage")!;
    expect(usageEnv.payload).toEqual({
      tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
      cost: 0.0042,
    });
    expect(store.getConversation(conv.id, "platform")?.usage).toEqual({
      tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
      cost: 0.0042,
    });
  });

  it("marks degraded when the child dies, then recovers on next prompt", async () => {
    const { store, supervisor, children } = makeSupervisor();
    s = supervisor;
    const conv = store.createConversation({ namespace: "platform" });
    await supervisor.prompt(conv.id, "hi"); // accepted; turn settles async
    await vi.waitFor(() => {
      expect(store.getConversation(conv.id, "platform")?.state).toBe("idle");
    });
    // Simulate a crash: SIGKILL the child from the outside. (killChild is
    // the gateway's INTENTIONAL kill — delete/abandon — and no longer
    // publishes degraded since #85.)
    children[0]!.kill("SIGKILL");
    await vi.waitFor(() => {
      expect(store.getConversation(conv.id, "platform")?.state).toBe("degraded");
    });
    const ok = await supervisor.prompt(conv.id, "again"); // respawn
    expect(ok).toBe(true);
    await vi.waitFor(() => {
      expect(store.getConversation(conv.id, "platform")?.state).toBe("idle");
    });
  });

  it("re-prompting after killChild lifts the dead mark so events flow again (2nd review)", async () => {
    const { store, bus, supervisor } = makeSupervisor();
    s = supervisor;
    const conv = store.createConversation({ namespace: "platform" });
    await supervisor.prompt(conv.id, "hi");
    await vi.waitFor(() => {
      expect(store.getConversation(conv.id, "platform")?.state).toBe("idle");
    });
    // abandon route semantics: intentional kill.
    supervisor.killChild(conv.id);
    // Wait for the killed host's exit to fire (dead lifted there), then
    // re-prompt. Before the fix, the dead set permanently silenced the
    // respawned host: no deltas, and agent_settled was dropped so the
    // thread stayed "streaming" forever.
    await vi.waitFor(() => {
      expect(supervisor.has(conv.id)).toBe(false);
    });
    const eventsBefore = store.getEventsSince(conv.id, -1).length;
    expect(await supervisor.prompt(conv.id, "round two")).toBe(true);
    await vi.waitFor(() => {
      expect(store.getConversation(conv.id, "platform")?.state).toBe("idle");
    });
    const kinds = bus.replay(conv.id, eventsBefore - 1).map((e) => e.kind);
    expect(kinds).toContain("text_delta");
    expect(kinds).toContain("session_state"); // idle — agent_settled not dropped
  });

  it("replays nothing for a fresh conversation", () => {
    const { bus, store } = makeSupervisor();
    const conv = store.createConversation({ namespace: "platform" });
    expect(bus.replay(conv.id, -1)).toEqual([]);
  });

  // Graceful shutdown (spec §11): SIGTERM should give the child up to 5s to
  // exit before disposeAll resolves. Without this, a deploy during a turn
  // kills the child mid-prompt and the user sees a partial response.
  it("disposeAll awaits child exit (graceful shutdown)", async () => {
    const { supervisor, store } = makeSupervisor();
    const conv = store.createConversation({ namespace: "platform" });
    await supervisor.prompt(conv.id, "hi", undefined, { LAPIS_PROJECT_KEY: "platform" });
    // Child is running. disposeAll should not resolve until the child exits.
    const start = Date.now();
    await supervisor.disposeAll();
    const elapsed = Date.now() - start;
    // fake-pi.mjs settles quickly (within the 5s timeout), so we expect
    // a real wait, not an instant return.
    expect(supervisor.has(conv.id)).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(0);
    // Upper bound: disposeAll's internal timeout is 5s, so a resolved call
    // lands well under 6s even when the machine is loaded (CI/parallel
    // builds). The bound proves the call resolves instead of hanging.
    expect(elapsed).toBeLessThan(6_000);
  });

  // Spec §6 + §10: workspace plumbs through to spawn cwd; respawn after a
  // crash reuses the same cwd so pi finds its prior session file on disk.
  it("spawns session host with conversation.workspace as cwd, and reuses it after a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aelvyril-ws-"));
    tmpDirs.push(dir);
    const store = new Store(":memory:");
    const conv = store.createConversation({ workspace: dir, namespace: "platform" });
    const spawnCalls: Array<{ cwd: string | undefined; env: Record<string, string> }> = [];
    const children: ChildProcess[] = [];
    const bus = new EventBus(store);
    const supervisor = new Supervisor({
      bus,
      store,
      spawnChild: (_cid, extraEnv, cwd) => {
        spawnCalls.push({ cwd: cwd ?? undefined, env: { ...extraEnv } });
        const child = spawn(process.execPath, [fakePi], { cwd, env: { ...process.env, ...extraEnv } });
        children.push(child);
        return child;
      },
      idleMs: 60_000,
    });
    s = supervisor;

    expect(await supervisor.prompt(conv.id, "hi", undefined, { LAPIS_PROJECT_KEY: "platform" })).toBe(true);
    await vi.waitFor(() => {
      expect(store.getConversation(conv.id, "platform")?.state).toBe("idle");
    });
    // External crash (not killChild — see the degraded-on-crash test above).
    children[0]!.kill("SIGKILL");
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

  it("auto-responds cancelled to pi dialog requests so headless runs settle (#84)", async () => {
    process.env.FAKE_UI_DIALOG = "1";
    try {
      const { store, bus, supervisor } = makeSupervisor();
      s = supervisor;
      const conv = store.createConversation({ namespace: "platform" });
      const seen: EventEnvelope[] = [];
      bus.subscribe(conv.id, (e) => seen.push(e));
      await supervisor.prompt(conv.id, "hi");
      // The ack (custom envelope) proves the gateway actually wrote the
      // extension_ui_response back to the child.
      await vi.waitFor(() => {
        expect(
          seen.some(
            (e) =>
              e.kind === "custom" &&
              (e.payload as { type?: string }).type === "custom_ui_response_received",
          ),
        ).toBe(true);
      });
      const dialog = seen.find((e) => e.kind === "dialog");
      expect(dialog?.payload).toMatchObject({
        method: "confirm",
        title: "Allow project agents?",
        action: "auto_cancelled",
      });
      // The dialog did not hang or block the run.
      await vi.waitFor(() => {
        expect(store.getConversation(conv.id, "platform")?.state).toBe("idle");
      });
    } finally {
      delete process.env.FAKE_UI_DIALOG;
    }
  });

  it("dialogMode=blocked escalates blocking dialogs to the needs-you state (#84)", async () => {
    process.env.FAKE_UI_DIALOG = "1";
    try {
      const { store, bus, supervisor } = makeSupervisor({ dialogMode: "blocked" });
      s = supervisor;
      const conv = store.createConversation({ namespace: "platform" });
      const seen: EventEnvelope[] = [];
      bus.subscribe(conv.id, (e) => seen.push(e));
      await supervisor.prompt(conv.id, "hi");
      await vi.waitFor(() => {
        expect(store.getConversation(conv.id, "platform")?.state).toBe("blocked");
      });
      const dialog = seen.find((e) => e.kind === "dialog");
      expect(dialog?.payload).toMatchObject({ method: "confirm", action: "blocked" });
      const blockedState = seen.find(
        (e) => e.kind === "session_state" && (e.payload as { state?: string }).state === "blocked",
      );
      expect(blockedState?.payload).toMatchObject({ state: "blocked", reason: "dialog" });
      // The mock now holds the turn open like real pi (no answer is coming
      // in blocked mode), so nothing settles over the escalation. This is
      // the exact race CI caught when the mock kept streaming: agent_settled
      // marked the thread idle and erased the blocked state.
      await new Promise((r) => setTimeout(r, 400));
      expect(store.getConversation(conv.id, "platform")?.state).toBe("blocked");
      expect(
        seen.some(
          (e) => e.kind === "session_state" && (e.payload as { state?: string }).state === "idle",
        ),
      ).toBe(false);
    } finally {
      delete process.env.FAKE_UI_DIALOG;
    }
  });

  it("crossing the per-thread cost cap blocks the thread (#84)", async () => {
    const { store, bus, supervisor } = makeSupervisor({ maxCostPerThreadUsd: 0.001 });
    s = supervisor;
    const conv = store.createConversation({ namespace: "platform" });
    const seen: EventEnvelope[] = [];
    bus.subscribe(conv.id, (e) => seen.push(e));
    await supervisor.prompt(conv.id, "hi");
    // fake-pi reports cost 0.0042 > 0.001 cap → blocked/capped at harvest.
    await vi.waitFor(() => {
      expect(store.getConversation(conv.id, "platform")?.state).toBe("blocked");
    });
    const blockedState = seen.find(
      (e) => e.kind === "session_state" && (e.payload as { state?: string }).state === "blocked",
    );
    expect(blockedState?.payload).toMatchObject({ state: "blocked", reason: "capped" });
    expect(store.getConversation(conv.id, "platform")?.usage?.cost).toBe(0.0042);
  });

  // #77: the kill is SIGTERM-first with a timed SIGKILL escalation — the
  // old unconditional SIGKILL threw away the graceful-drain chance.
  it("killChild SIGTERMs first and escalates to SIGKILL after the grace (#77)", async () => {
    const { store, supervisor, children } = makeFakeSupervisor({ killGraceMs: 80 });
    s = supervisor;
    const conv = store.createConversation({ namespace: "platform" });
    expect(await supervisor.prompt(conv.id, "hi")).toBe(true);
    const child = children[0]!;
    supervisor.killChild(conv.id);
    // First signal is SIGTERM; the fake ignores it (stays alive).
    expect(child.kills).toEqual(["SIGTERM"]);
    expect(supervisor.has(conv.id)).toBe(false); // handle forgotten synchronously
    // The grace expiry lands the SIGKILL and the exit fires.
    await vi.waitFor(() => expect(child.signalCode).toBe("SIGKILL"));
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    await vi.waitFor(() => expect(supervisor.runningCount()).toBe(0));
  });

  // #77 finding 2: the reaper used to delete the handle right after the
  // SIGTERM — a child ignoring SIGTERM became an unkillable orphan AND the
  // next prompt spawned a second pi on the same session file.
  it("reapIdle keeps the handle until exit; the next prompt waits instead of double-spawning (#77)", async () => {
    const { store, supervisor, children } = makeFakeSupervisor({ idleMs: 30, killGraceMs: 1_000 });
    s = supervisor;
    const conv = store.createConversation({ namespace: "platform" });
    expect(await supervisor.prompt(conv.id, "hi")).toBe(true);
    // The reaper ticks every min(idleMs, 5s) = 30ms and SIGTERMs the idle host.
    await vi.waitFor(() => expect(children[0]!.kills).toContain("SIGTERM"));
    // The handle stays registered until 'exit' fires (well inside the 1s grace).
    expect(supervisor.has(conv.id)).toBe(true);
    // A prompt while the SIGTERMed host is still alive must NOT spawn a
    // second pi on the same session file — it waits for the dying host.
    const duringGrace = supervisor.prompt(conv.id, "during grace");
    await new Promise((r) => setTimeout(r, 50));
    expect(children).toHaveLength(1);
    // The SIGKILL escalation (killGraceMs) ends it; the waiting prompt
    // respawns a fresh host and completes.
    expect(await duringGrace).toBe(true);
    expect(children).toHaveLength(2);
    expect(children[0]!.kills).toEqual(["SIGTERM", "SIGKILL"]);
    // The respawned fake ignores SIGTERM — dispose it here with a short
    // grace so afterEach's unawaited disposeAll doesn't park a 5s timer.
    await supervisor.disposeAll(50);
  });

  // #77: shutdown used to orphan a child that ignored SIGTERM — disposeAll
  // now escalates to SIGKILL at the timeout instead of giving up.
  it("disposeAll escalates to SIGKILL when the shutdown grace expires (#77)", async () => {
    const { store, supervisor, children } = makeFakeSupervisor({ killGraceMs: 60 });
    s = supervisor;
    const conv = store.createConversation({ namespace: "platform" });
    await supervisor.prompt(conv.id, "hi");
    const start = Date.now();
    await supervisor.disposeAll(60);
    expect(children[0]!.kills).toEqual(["SIGTERM", "SIGKILL"]);
    // The wait held until the escalation fired, not an instant return.
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
  });
});
