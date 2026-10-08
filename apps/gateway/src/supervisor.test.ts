import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventBus } from "./bus.js";
import { Store } from "./store.js";
import { Supervisor, type SupervisorOptions } from "./supervisor.js";
import type { EventEnvelope } from "@aelvyril/shared";
import type { FilePatch } from "./workspace-git.js";

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

  // Review P2: with no workspace the host spawns in a per-thread scratch dir
  // under the OS temp dir — never inside the gateway's own repo tree.
  it("falls back to a per-thread tmpdir scratch cwd when the conversation has no workspace", async () => {
    const store = new Store(":memory:");
    const conv = store.createConversation({ namespace: "platform" }); // no workspace
    const spawnCalls: Array<{ cwd: string | undefined }> = [];
    const supervisor = new Supervisor({
      bus: new EventBus(store),
      store,
      spawnChild: (_cid, _extraEnv, cwd) => {
        spawnCalls.push({ cwd: cwd ?? undefined });
        return spawn(process.execPath, [fakePi], { cwd });
      },
      idleMs: 60_000,
    });
    s = supervisor;
    await supervisor.prompt(conv.id, "hi");
    expect(spawnCalls).toHaveLength(1);
    const cwd = spawnCalls[0]!.cwd!;
    // Under the OS temp root, namespaced to aelvyril-sessions/<thread id>.
    expect(cwd.startsWith(join(tmpdir(), "aelvyril-sessions"))).toBe(true);
    expect(cwd.endsWith(conv.id)).toBe(true);
    expect(existsSync(cwd)).toBe(true); // created before the spawn
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

  // #80 fix 2: specMode is no longer dropped — force wraps the prompt with
  // the interview protocol, off forwards it verbatim.
  it("prompt forwards specMode: force wraps, off passes verbatim (#80)", async () => {
    const written: string[] = [];
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const child = fakeRpcChild();
    const rawWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = (buf: string) => {
      written.push(buf);
      return rawWrite(buf);
    };
    const supervisor = new Supervisor({
      bus,
      store,
      spawnChild: () => child as unknown as ChildProcess,
      idleMs: 60_000,
    });
    s = supervisor;
    const conv = store.createConversation({ namespace: "platform" });
    await supervisor.prompt(conv.id, "casual ask", undefined, {}, undefined, "off");
    await supervisor.prompt(conv.id, "big ask", undefined, {}, undefined, "force");
    const prompts = written
      .map((w) => JSON.parse(w) as { type: string; message?: string })
      .filter((m) => m.type === "prompt");
    expect(prompts[0]!.message).toBe("casual ask");
    expect(prompts[1]!.message).toContain("big ask");
    expect(prompts[1]!.message).toContain("custom_spec_question");
    expect(prompts[1]!.message).toContain("forced spec mode");
  });

  // Review P1 rework of the #85 dead-mark: the old per-conversation Set
  // silenced a RESPAWNED host until the killed child exited. The mark is
  // child-identity-keyed now: only the zombie's events drop, and
  // prepareTurn awaits the zombie's exit before spawning (no double pi on
  // one session file).
  it("killChild drops only the OLD child's events; re-prompt delivers the respawned host immediately", async () => {
    const { store, bus, supervisor, children } = makeFakeSupervisor({ killGraceMs: 150 });
    s = supervisor;
    const conv = store.createConversation({ namespace: "platform" });
    expect(await supervisor.prompt(conv.id, "hi")).toBe(true);
    const oldChild = children[0]!;
    supervisor.killChild(conv.id);
    // The old fake ignores SIGTERM — it is still alive.
    expect(oldChild.exitCode).toBeNull();
    expect(oldChild.signalCode).toBeNull();
    // Re-prompt IMMEDIATELY (abandon → change mind). The replacement must
    // NOT spawn while the zombie lives, and its events must not be dropped.
    const reprompt = supervisor.prompt(conv.id, "round two");
    await new Promise((r) => setTimeout(r, 40));
    expect(children).toHaveLength(1); // still waiting on the zombie
    expect(await reprompt).toBe(true);
    await vi.waitFor(() => expect(children).toHaveLength(2)); // zombie exited → respawn
    // The NEW host's events flow: agent_settled is NOT dropped — the thread
    // ends idle instead of hanging "streaming" forever.
    await vi.waitFor(() => {
      expect(store.getConversation(conv.id, "platform")?.state).toBe("idle");
    });
    const states = bus
      .replay(conv.id, -1)
      .filter((e) => e.kind === "session_state")
      .map((e) => (e.payload as { state: string }).state);
    expect(states).toContain("streaming");
    expect(states.at(-1)).toBe("idle");
    expect(oldChild.kills).toEqual(["SIGTERM", "SIGKILL"]);
    // Cleanup: the respawned fake also ignores SIGTERM.
    await supervisor.disposeAll(50);
  });

  // Review P2: the postTurnPipeline is async — a newer user turn must not
  // inherit the stale pipeline's verify-retry or its markReviewed.
  it("postTurnPipeline bails when a newer turn started — no stale markReviewed", async () => {
    const gates: Array<(files: FilePatch[]) => void> = [];
    let diffCalls = 0;
    const { store, bus, supervisor } = makeFakeSupervisor({
      computeDiff: async () => {
        const i = diffCalls++;
        return new Promise<FilePatch[]>((resolve) => {
          gates[i] = resolve;
        });
      },
      verify: {
        commandsOverride: "pnpm test",
        exec: async (command) => ({ command: command.join(" "), ok: true, output: "green" }),
        retries: 3,
      },
    });
    s = supervisor;
    const conv = store.createConversation({ namespace: "platform", workspace: "/tmp/ws-review" });
    await supervisor.prompt(conv.id, "turn one");
    // Turn two starts while turn one's pipeline is parked on its diff.
    await supervisor.prompt(conv.id, "turn two");
    await vi.waitFor(() => expect(diffCalls).toBe(2));
    gates[0]!([{ path: "a.ts", patch: "+x" }]);
    gates[1]!([{ path: "a.ts", patch: "+x" }]);
    // Both pipelines verified green, but only the FRESH one (turn two's)
    // may mark the thread reviewed — the stale pipeline must bail.
    await vi.waitFor(() => {
      const reviewed = bus
        .replay(conv.id, -1)
        .filter((e) => e.kind === "spec_status")
        .map((e) => (e.payload as { status?: string }).status);
      expect(reviewed).toEqual(["reviewed"]);
    });
  });

  // Review P3: fractional pi stats must be coerced (Math.floor) — the
  // usage envelope's int schema used to silently drop them.
  it("harvestUsage floors fractional token stats so the envelope survives the schema", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const child = fakeRpcChild();
    const rawWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = (buf: string) => {
      const cmd = JSON.parse(buf) as { id?: string; type: string };
      if (cmd.type === "get_session_stats") {
        setImmediate(() => {
          child.stdout.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                id: cmd.id,
                type: "response",
                command: cmd.type,
                success: true,
                data: {
                  tokens: { input: 100.7, output: 50.2, cacheRead: 10.5, cacheWrite: 5.9, total: 165.3 },
                  cost: 0.00425,
                },
              }) + "\n",
            ),
          );
        });
      }
      return rawWrite(buf);
    };
    const supervisor = new Supervisor({
      bus,
      store,
      spawnChild: () => child as unknown as ChildProcess,
      idleMs: 60_000,
    });
    s = supervisor;
    const conv = store.createConversation({ namespace: "platform" });
    await supervisor.prompt(conv.id, "hi");
    await vi.waitFor(() => {
      expect(bus.replay(conv.id, -1).some((e) => e.kind === "usage")).toBe(true);
    });
    const usage = bus.replay(conv.id, -1).find((e) => e.kind === "usage")!.payload;
    expect(usage).toEqual({
      tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
      cost: 0.00425, // fractional cost is legit (schema allows it)
    });
    expect(store.getConversation(conv.id, "platform")?.usage).toEqual(usage);
  });

  // Review (ADR-0004): approve/retry can spawn a NEW session host (gateway
  // restart or host death between spec'ing and approve), and the child env
  // decides the memory namespace at module load. The namespace key must ride
  // along — the old empty extraEnv sent memory writes to the default ns.
  it("approve/retry with no live host respawn children whose env carries LAPIS_PROJECT_KEY", async () => {
    const envs: Array<Record<string, string>> = [];
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const supervisor = new Supervisor({
      bus,
      store,
      spawnChild: (_cid, extraEnv) => {
        envs.push({ ...extraEnv });
        return fakeRpcChild() as unknown as ChildProcess;
      },
      idleMs: 60_000,
      killGraceMs: 80,
    });
    s = supervisor;
    const conv = store.createConversation({ namespace: "user:u1" });
    // Seed the persisted draft so approve works without a live session (#80).
    store.setSpecDraftById(conv.id, {
      goal: "g",
      filesAffected: [],
      plan: ["edit src/a.ts"],
      risks: [],
      questions: [],
      answers: {},
    });

    // Approve with NO live host: a fresh child must be spawned, and its env
    // must carry the conversation's namespace.
    expect(await supervisor.approveExecution(conv.id)).toBe(true);
    expect(supervisor.has(conv.id)).toBe(true);
    expect(envs).toHaveLength(1);
    expect(envs[0]!.LAPIS_PROJECT_KEY).toBe("user:u1");

    // Host death → retry respawns too; the key must ride along again.
    supervisor.killChild(conv.id);
    await vi.waitFor(() => expect(supervisor.has(conv.id)).toBe(false));
    expect(await supervisor.retryExecution(conv.id)).toBe(true);
    expect(envs).toHaveLength(2);
    expect(envs[1]!.LAPIS_PROJECT_KEY).toBe("user:u1");
    // The respawned fake ignores SIGTERM — dispose with a short grace.
    await supervisor.disposeAll(50);
  });

  // Review: gateStopped was only reset by beginExecution, so a plain
  // re-prompt after a gate stop left the thread stuck "streaming" until the
  // idle reaper — the settle pipeline never ran again.
  it("a plain re-prompt after a gate stop settles idle + harvests usage (gateStopped resets per turn)", async () => {
    const child = fakeRpcChild();
    const rawWrite = child.stdin.write.bind(child.stdin);
    let gated = false;
    child.stdin.write = (buf: string) => {
      const cmd = JSON.parse(buf) as { type: string };
      if (cmd.type === "get_session_stats") {
        // fakeRpcChild answers stats without a data payload; the settle-path
        // usage harvest under test needs real stats.
        const id = (JSON.parse(buf) as { id?: string }).id;
        setImmediate(() => {
          child.stdout.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                id,
                type: "response",
                command: "get_session_stats",
                success: true,
                data: {
                  tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 1, total: 17 },
                  cost: 0.001,
                },
              }) + "\n",
            ),
          );
        });
      }
      if (cmd.type === "prompt" && !gated) {
        // Turn 1 only: the agent fires a GATED action mid-run.
        gated = true;
        setImmediate(() => {
          child.stdout.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                type: "tool_execution_start",
                toolCallId: "call_gated",
                toolName: "bash",
                args: { command: "rm -rf ./build-output" },
              }) + "\n",
            ),
          );
          child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "agent_settled" }) + "\n"));
        });
      }
      return rawWrite(buf);
    };
    const { store, bus, supervisor } = makeFakeSupervisor({
      spawnChild: () => child as unknown as ChildProcess,
    });
    s = supervisor;
    const conv = store.createConversation({ namespace: "platform" });
    const seen: EventEnvelope[] = [];
    bus.subscribe(conv.id, (e) => seen.push(e));

    expect(await supervisor.prompt(conv.id, "hi")).toBe(true);
    // Turn 1 hits the gate: blocked escalation, and the settle it triggered
    // is SUPPRESSED (gateStopped) — no idle write, no usage harvest.
    await vi.waitFor(() => {
      expect(store.getConversation(conv.id, "platform")?.state).toBe("blocked");
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.some((e) => e.kind === "usage")).toBe(false);
    expect(
      seen.some((e) => e.kind === "session_state" && (e.payload as { state: string }).state === "idle"),
    ).toBe(false);

    // Turn 2 is a plain prompt: gateStopped must reset with the new turn so
    // the settle pipeline runs (idle write + usage harvest) instead of
    // leaving the thread "streaming" forever.
    expect(await supervisor.prompt(conv.id, "round two")).toBe(true);
    await vi.waitFor(() => {
      expect(store.getConversation(conv.id, "platform")?.state).toBe("idle");
    });
    await vi.waitFor(() => {
      expect(seen.some((e) => e.kind === "usage")).toBe(true);
    });
    await supervisor.disposeAll(50);
  });

  // SHOULD-FIX: the gate's abort is async — when its settle arrives AFTER a
  // newer turn un-parked the thread (beginUserTurn cleared gateStopped), it
  // used to pass the guard: wrote idle over the new turn's "streaming",
  // harvested usage, and ran the pipeline over the aborted half-turn. The
  // abort's settle is now consumed once and dropped; the new turn's own
  // settle behaves normally.
  it("the gated turn's abort-settle is dropped when a newer turn started before it arrived", async () => {
    const child = fakeRpcChild();
    const rawWrite = child.stdin.write.bind(child.stdin);
    let userTurns = 0;
    child.stdin.write = (buf: string) => {
      const cmd = JSON.parse(buf) as { id?: string; type: string };
      if (cmd.type === "get_session_stats") {
        // fakeRpcChild answers stats without a data payload; the harvest
        // under test needs real stats.
        const id = cmd.id;
        setImmediate(() => {
          child.stdout.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                id,
                type: "response",
                command: "get_session_stats",
                success: true,
                data: {
                  tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 1, total: 17 },
                  cost: 0.001,
                },
              }) + "\n",
            ),
          );
        });
        return rawWrite(buf);
      }
      if (cmd.type === "prompt") {
        userTurns++;
        const id = cmd.id;
        setImmediate(() => {
          if (typeof id === "string") {
            child.stdout.emit(
              "data",
              Buffer.from(JSON.stringify({ id, type: "response", command: "prompt", success: true }) + "\n"),
            );
          }
          if (userTurns === 1) {
            // Turn 1 only: fire a GATED action and HOLD the turn open (no
            // settle) so turn 2 can start before the abort-settle arrives.
            child.stdout.emit(
              "data",
              Buffer.from(
                JSON.stringify({
                  type: "tool_execution_start",
                  toolCallId: "call_gated",
                  toolName: "bash",
                  args: { command: "rm -rf ./build-output" },
                }) + "\n",
              ),
            );
          }
          // No agent_settled here: the test drives both settles explicitly.
        });
        return true;
      }
      return rawWrite(buf); // abort etc. answered by the plain fake
    };
    const { store, bus, supervisor } = makeFakeSupervisor({
      spawnChild: () => child as unknown as ChildProcess,
    });
    s = supervisor;
    const conv = store.createConversation({ namespace: "platform" });
    const seen: EventEnvelope[] = [];
    bus.subscribe(conv.id, (e) => seen.push(e));

    // Turn 1: gated tool → escalateGate (blocked + abort in flight, settle
    // withheld by the fake).
    expect(await supervisor.prompt(conv.id, "hi")).toBe(true);
    await vi.waitFor(() => {
      expect(store.getConversation(conv.id, "platform")?.state).toBe("blocked");
    });
    expect(seen.some((e) => e.kind === "usage")).toBe(false);

    // Turn 2 starts BEFORE the aborted turn's settle arrives (generation
    // bump; beginUserTurn clears gateStopped).
    expect(await supervisor.prompt(conv.id, "round two")).toBe(true);
    expect(store.getConversation(conv.id, "platform")?.state).toBe("streaming");

    // The OLD turn's abort-settle arrives now: it must be dropped — no idle
    // write, no usage harvest, no pipeline over the aborted half-turn.
    child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "agent_settled" }) + "\n"));
    await new Promise((r) => setTimeout(r, 50));
    expect(store.getConversation(conv.id, "platform")?.state).toBe("streaming");
    expect(seen.some((e) => e.kind === "usage")).toBe(false);
    expect(
      seen.some((e) => e.kind === "session_state" && (e.payload as { state: string }).state === "idle"),
    ).toBe(false);

    // The NEW turn's own settle behaves normally: idle + usage harvest.
    child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "agent_settled" }) + "\n"));
    await vi.waitFor(() => {
      expect(store.getConversation(conv.id, "platform")?.state).toBe("idle");
    });
    await vi.waitFor(() => {
      expect(seen.some((e) => e.kind === "usage")).toBe(true);
    });
    expect(
      seen.filter((e) => e.kind === "session_state" && (e.payload as { state: string }).state === "idle"),
    ).toHaveLength(1);
    await supervisor.disposeAll(50);
  });

  // Review: specRounds was lifetime-of-handle, so a turn-2 interview got
  // instantly cut with "Question budget exhausted" despite the budget being
  // documented as per-interview.
  it("specRounds resets per user turn: turn 2 gets a full question budget", async () => {
    const child = fakeRpcChild();
    const rawWrite = child.stdin.write.bind(child.stdin);
    const questionLine =
      JSON.stringify({
        type: "custom_spec_question",
        questions: [{ id: "q1", prompt: "What shape?", kind: "text" }],
      }) + "\n";
    const budgetReplies: string[] = [];
    let userTurns = 0;
    child.stdin.write = (buf: string) => {
      const cmd = JSON.parse(buf) as { type: string; message?: string };
      if (cmd.type === "prompt") {
        const msg = String(cmd.message ?? "");
        if (msg.startsWith("Question budget")) {
          budgetReplies.push(msg);
        } else {
          // A user turn (not a contract reply): turn 1 interviews with two
          // rounds (budget is 1 → the second must trip the cut); turn 2 with
          // one.
          userTurns++;
          const firstTurn = userTurns === 1;
          setImmediate(() => {
            child.stdout.emit("data", Buffer.from(questionLine));
            if (firstTurn) child.stdout.emit("data", Buffer.from(questionLine));
          });
        }
      }
      return rawWrite(buf);
    };
    const { store, bus, supervisor } = makeFakeSupervisor({
      specMaxRounds: 1,
      spawnChild: () => child as unknown as ChildProcess,
    });
    s = supervisor;
    const conv = store.createConversation({ namespace: "platform" });
    const seen: EventEnvelope[] = [];
    bus.subscribe(conv.id, (e) => seen.push(e));

    await supervisor.prompt(conv.id, "turn one ask", undefined, {}, undefined, "off");
    await vi.waitFor(() => expect(budgetReplies).toHaveLength(1));
    const questionsTurn1 = seen.filter((e) => e.kind === "spec_question").length;
    expect(questionsTurn1).toBeGreaterThanOrEqual(2);

    // Turn 2: a fresh interview budget — one round against a budget of 1 is
    // legal, so no "Question budget exhausted" reply may fire.
    await supervisor.prompt(conv.id, "turn two ask", undefined, {}, undefined, "off");
    await vi.waitFor(() => {
      expect(seen.filter((e) => e.kind === "spec_question").length).toBe(questionsTurn1 + 1);
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(budgetReplies).toHaveLength(1);
    expect(budgetReplies[0]).toContain("(1 rounds)");
    await supervisor.disposeAll(50);
  });

  // Review P2, fail-closed: when the scratch dir cannot be created the child
  // used to fall back to process.cwd() — the gateway's own repo tree. The
  // mkdir failure must fail the prompt instead (never spawn).
  it("fails the prompt when the scratch dir cannot be created (never a cwd fallback)", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const conv = store.createConversation({ namespace: "platform" }); // no workspace
    // Block the scratch dir: a FILE where mkdirSync must create a directory
    // (ENOTDIR/EEXIST on every supported platform).
    const blocker = join(tmpdir(), "aelvyril-sessions", conv.id);
    writeFileSync(blocker, "not a directory");
    let spawned = false;
    const supervisor = new Supervisor({
      bus,
      store,
      spawnChild: () => {
        spawned = true;
        return spawn(process.execPath, [fakePi]);
      },
      idleMs: 60_000,
    });
    s = supervisor;
    try {
      await expect(supervisor.prompt(conv.id, "hi")).rejects.toThrow();
      expect(spawned).toBe(false);
    } finally {
      rmSync(blocker, { force: true });
    }
  });

  // Review: contract replies rode `void rpc.send().catch(() => {})` — a dead
  // stdin / rpc timeout on the fire-and-forget reply vanished. The failure
  // must be observable via the supervisor's logger at warn level.
  it("contract reply failures reach the wired logger at warn (onReplyFailure)", async () => {
    const warns: Array<{ obj: unknown; msg: string }> = [];
    const child = fakeRpcChild();
    const rawWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = (buf: string) => {
      const cmd = JSON.parse(buf) as { type: string; message?: string };
      if (cmd.type === "prompt" && !String(cmd.message ?? "").startsWith("Spec approved")) {
        // A reversible draft arrives, then the host DIES before the auto-run
        // execution prompt (the contract's reply) can be answered. The
        // nested setImmediate lets the initial prompt's own response land
        // first — only the REPLY must fail.
        setImmediate(() => {
          setImmediate(() => {
            child.stdout.emit(
              "data",
              Buffer.from(
                JSON.stringify({
                  type: "custom_spec_draft",
                  draft: {
                    goal: "g",
                    filesAffected: [],
                    plan: ["edit src/a.ts"],
                    risks: [],
                    questions: [],
                    answers: {},
                  },
                }) + "\n",
              ),
            );
            child.emit("exit", 1);
          });
        });
      }
      return rawWrite(buf);
    };
    const { store, supervisor } = makeFakeSupervisor({
      spawnChild: () => child as unknown as ChildProcess,
      logger: {
        warn: (obj: object, msg?: string) => {
          warns.push({ obj, msg: String(msg) });
        },
      },
    });
    s = supervisor;
    const conv = store.createConversation({ namespace: "platform" });
    expect(await supervisor.prompt(conv.id, "hi", undefined, {}, undefined, "off")).toBe(true);
    await vi.waitFor(() => expect(warns).toHaveLength(1));
    expect(warns[0]!.msg).toContain("reply failed");
    expect((warns[0]!.obj as { err: Error }).err).toBeInstanceOf(Error);
    await supervisor.disposeAll(50);
  });
});
