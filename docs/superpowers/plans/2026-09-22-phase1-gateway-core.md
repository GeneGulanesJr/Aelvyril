# Phase 1 — Gateway Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `pi-subagent-driven-development` to implement this plan task-by-task. **Sequential mode** (one `worker` subagent per task, two-stage review). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Fastify gateway that owns conversation records, spawns one RPC child process per conversation (fake script in this phase), normalizes protocol events into the shared `EventEnvelope`, persists every event to SQLite, and streams them to clients over SSE with `Last-Event-ID` replay.

**Architecture:** `apps/gateway` with four layers: **data** (better-sqlite3, WAL: conversations + per-conversation monotonic event seq), **protocol** (strict JSONL RPC client — LF-only framing, no `readline`; request/response correlation by id), **supervisor** (child lifecycle: spawn-on-demand, prompt/abort, crash → `degraded` + respawn-on-next-prompt, idle reap), **HTTP** (v1 routes + SSE). Mapping: `message_update/text_delta → text_delta`, `tool_execution_start/end → tool_call/tool_result`, turn lifecycle → `session_state`, failures → `error`. No auth in this phase (spec Phase 1 scope).

**Tech Stack:** Fastify ^5, better-sqlite3 ^11, tsx (runtime), vitest ^3, TypeScript strict. Depends on `@aelvyril/shared` (workspace).

**Key protocol facts (spec §14):** LF is the only delimiter; strip one trailing `\r`; never use Node `readline` (splits U+2028/U+2029); use `StringDecoder` for multibyte; no ready handshake; every command gets one `{id, type:"response", command, success}` reply; `prompt` while streaming requires `streamingBehavior`; default provider is google (irrelevant to the fake child, critical in Phase 3).

---

### Task 1: Gateway scaffold

**Files:**
- Create: `apps/gateway/package.json`
- Create: `apps/gateway/tsconfig.json`
- Create: `apps/gateway/vitest.config.ts`
- Create: `apps/gateway/src/app.ts`
- Create: `apps/gateway/src/index.ts`
- Test: `apps/gateway/src/app.test.ts`
- Modify: `.gitignore` (add `data/`)

- [ ] **Step 1: Write the failing health test** — `apps/gateway/src/app.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("health", () => {
  it("responds ok", async () => {
    const app = buildApp({ dbPath: ":memory:", childCommand: "node", childArgs: [] });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @aelvyril/gateway test`
Expected: FAIL — package does not exist.

- [ ] **Step 3: Create the package files**

`apps/gateway/package.json`:

```json
{
  "name": "@aelvyril/gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "build": "tsc --noEmit"
  },
  "dependencies": {
    "@aelvyril/shared": "workspace:*",
    "better-sqlite3": "^13.0.3",
    "fastify": "^5.2.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^22.10.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

`apps/gateway/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "types": ["node"] },
  "include": ["src", "vitest.config.ts"]
}
```

`apps/gateway/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { environment: "node", testTimeout: 15000 } });
```

`apps/gateway/src/app.ts` (placeholder — later tasks extend `AppOptions`):

```ts
import Fastify, { type FastifyInstance } from "fastify";

export interface AppOptions {
  dbPath: string;
  childCommand: string;
  childArgs: string[];
  idleMs?: number;
}

export function buildApp(_opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get("/healthz", async () => ({ ok: true }));
  return app;
}
```

`apps/gateway/src/index.ts`:

```ts
import { buildApp } from "./app.js";

const port = Number(process.env.GATEWAY_PORT ?? 8787);
const app = buildApp({
  dbPath: process.env.GATEWAY_DB ?? "./data/gateway.db",
  childCommand: process.env.PI_COMMAND ?? "pi",
  childArgs: ["--mode", "rpc"],
});

app.listen({ port, host: "127.0.0.1" }).then((addr) => {
  app.log.info(`gateway listening on ${addr}`);
});
```

Append to `.gitignore`:

```
data/
```

- [ ] **Step 4: Install and run test to verify it passes**

Run: `pnpm install && pnpm --filter @aelvyril/gateway test`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway .gitignore pnpm-lock.yaml
git commit -m "feat(gateway): package scaffold + healthz"
```

---

### Task 2: Data layer — store + event bus

**Files:**
- Create: `apps/gateway/src/store.ts`
- Create: `apps/gateway/src/bus.ts`
- Test: `apps/gateway/src/store.test.ts`
- Test: `apps/gateway/src/bus.test.ts`

- [ ] **Step 1: Write failing store tests** — `apps/gateway/src/store.test.ts`

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @aelvyril/gateway test`
Expected: FAIL — `./store.js` not found.

- [ ] **Step 3: Implement store** — `apps/gateway/src/store.ts`

```ts
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Conversation } from "@aelvyril/shared";

interface ConvRow {
  id: string;
  title: string | null;
  workspace: string | null;
  state: string;
  created_at: string;
}

export interface NewEvent {
  conversationId: string;
  ts: string;
  kind: string;
  payload: unknown;
}

export type StoredEvent = NewEvent & { seq: number };

export class Store {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations(
        id TEXT PRIMARY KEY,
        title TEXT,
        workspace TEXT,
        state TEXT NOT NULL DEFAULT 'idle',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events(
        conversation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (conversation_id, seq)
      );
    `);
  }

  createConversation(input: { title?: string; workspace?: string }): Conversation {
    const id = `conv_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO conversations(id, title, workspace, state, created_at) VALUES(?, ?, ?, 'idle', ?)",
      )
      .run(id, input.title ?? null, input.workspace ?? null, createdAt);
    return { id, title: input.title ?? null, workspace: input.workspace ?? null, state: "idle", createdAt };
  }

  getConversation(id: string): Conversation | null {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
      | ConvRow
      | undefined;
    return row ? this.toConversation(row) : null;
  }

  listConversations(): Conversation[] {
    const rows = this.db
      .prepare("SELECT * FROM conversations ORDER BY created_at DESC")
      .all() as ConvRow[];
    return rows.map((r) => this.toConversation(r));
  }

  setConversationState(id: string, state: string): void {
    this.db.prepare("UPDATE conversations SET state = ? WHERE id = ?").run(state, id);
  }

  appendEvent(ev: NewEvent): StoredEvent {
    return this.appendTxn(ev);
  }

  private appendTxn: (ev: NewEvent) => StoredEvent;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations(
        id TEXT PRIMARY KEY,
        title TEXT,
        workspace TEXT,
        state TEXT NOT NULL DEFAULT 'idle',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events(
        conversation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (conversation_id, seq)
      );
    `);
    // Assigned in the constructor: field initializers run BEFORE the
    // constructor body, so this.db would be undefined in a field initializer.
    this.appendTxn = this.db.transaction((ev: NewEvent): StoredEvent => {
      const row = this.db
        .prepare(
          "SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM events WHERE conversation_id = ?",
        )
        .get(ev.conversationId) as { next: number };
      const seq = row.next;
      this.db
        .prepare(
          "INSERT INTO events(conversation_id, seq, ts, kind, payload) VALUES(?, ?, ?, ?, ?)",
        )
        .run(ev.conversationId, seq, ev.ts, ev.kind, JSON.stringify(ev.payload));
      return { ...ev, seq };
    });
  }

  getEventsSince(conversationId: string, sinceSeq: number): StoredEvent[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM events WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC",
      )
      .all(conversationId, sinceSeq) as Array<{
      conversation_id: string;
      seq: number;
      ts: string;
      kind: string;
      payload: string;
    }>;
    return rows.map((r) => ({
      conversationId: r.conversation_id,
      seq: r.seq,
      ts: r.ts,
      kind: r.kind,
      payload: JSON.parse(r.payload) as unknown,
    }));
  }

  close(): void {
    this.db.close();
  }

  private toConversation(r: ConvRow): Conversation {
    return {
      id: r.id,
      title: r.title,
      workspace: r.workspace,
      state: r.state as Conversation["state"],
      createdAt: r.created_at,
    };
  }
}
```

- [ ] **Step 4: Write failing bus tests** — `apps/gateway/src/bus.test.ts`

```ts
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
    const conv = store.createConversation({});
    const seen: number[] = [];
    bus.subscribe(conv.id, (e) => seen.push(e.seq));
    bus.publish({ conversationId: conv.id, ts, kind: "text_delta", payload: { delta: "x" } });
    expect(seen).toEqual([0]);
  });

  it("unsubscribed listeners get nothing", () => {
    const { store, bus } = makeBus();
    const conv = store.createConversation({});
    const fn = vi.fn();
    const off = bus.subscribe(conv.id, fn);
    off();
    bus.publish({ conversationId: conv.id, ts, kind: "text_delta", payload: { delta: "x" } });
    expect(fn).not.toHaveBeenCalled();
  });

  it("replay returns persisted events after the given seq", () => {
    const { store, bus } = makeBus();
    const conv = store.createConversation({});
    bus.publish({ conversationId: conv.id, ts, kind: "text_delta", payload: { delta: "a" } });
    bus.publish({ conversationId: conv.id, ts, kind: "text_delta", payload: { delta: "b" } });
    expect(bus.replay(conv.id, 0)).toHaveLength(1);
  });
});
```

- [ ] **Step 5: Implement bus** — `apps/gateway/src/bus.ts`

```ts
import type { EventEnvelope } from "@aelvyril/shared";
import type { Store } from "./store.js";

type Listener = (envelope: EventEnvelope) => void;

export class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  constructor(private store: Store) {}

  subscribe(conversationId: string, fn: Listener): () => void {
    let set = this.listeners.get(conversationId);
    if (!set) {
      set = new Set();
      this.listeners.set(conversationId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(conversationId);
    };
  }

  /** Persist first (event log is the source of truth), then fan out live. */
  publish(envelope: Omit<EventEnvelope, "seq"> & { seq?: number }): EventEnvelope {
    const stored = this.store.appendEvent(envelope);
    const full = stored as EventEnvelope;
    const set = this.listeners.get(envelope.conversationId);
    if (set) for (const fn of set) fn(full);
    return full;
  }

  replay(conversationId: string, sinceSeq: number): EventEnvelope[] {
    return this.store.getEventsSince(conversationId, sinceSeq) as EventEnvelope[];
  }
}
```

- [ ] **Step 6: Run tests to verify pass**

Run: `pnpm --filter @aelvyril/gateway test`
Expected: PASS (9 tests total: 1 health + 5 store + 3 bus).

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src
git commit -m "feat(gateway): SQLite store + event bus (spec §6)"
```

---

### Task 3: Protocol layer — JSONL RPC client + fake child

**Files:**
- Create: `apps/gateway/src/rpc.ts`
- Create: `apps/gateway/fixtures/fake-pi.mjs`
- Test: `apps/gateway/src/rpc.test.ts`

- [ ] **Step 1: Write failing framing tests** — `apps/gateway/src/rpc.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { JsonlDecoder } from "./rpc.js";

describe("JsonlDecoder", () => {
  it("decodes complete lines across chunk boundaries", () => {
    const d = new JsonlDecoder();
    const a = d.push('{"a":1}\n{"b');
    const b = d.push('":2}\n');
    expect(a).toEqual([{ a: 1 }]);
    expect(b).toEqual([{ b: 2 }]);
  });

  it("strips a single trailing \\r", () => {
    const d = new JsonlDecoder();
    expect(d.push('{"a":1}\r\n')).toEqual([{ a: 1 }]);
  });

  it("does not split on U+2028 inside strings (readline would)", () => {
    const d = new JsonlDecoder();
    expect(d.push('{"s":"a\u2028b"}\n')).toEqual([{ s: "a\u2028b" }]);
  });

  it("holds partial multibyte sequences via StringDecoder", () => {
    const d = new JsonlDecoder();
    const bytes = Buffer.from('{"e":"?"}\n', "utf8");
    const split = 7; // inside the multibyte char
    const a = d.push(bytes.subarray(0, split));
    const b = d.push(bytes.subarray(split));
    expect(a).toEqual([]);
    expect(b).toEqual([{ e: "?" }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @aelvyril/gateway test`
Expected: FAIL — `./rpc.js` not found.

- [ ] **Step 3: Implement rpc.ts** (decoder + client; client types minimal per spec §14)

```ts
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import type { ChildProcess } from "node:child_process";

/**
 * Strict JSONL framing per pi RPC spec: LF is the ONLY delimiter; strip one
 * trailing \r; never use readline (it also splits on U+2028/U+2029 which are
 * valid inside JSON strings); StringDecoder handles multibyte straddling.
 */
export class JsonlDecoder {
  private buffer = "";
  private decoder = new StringDecoder("utf8");

  push(chunk: Buffer | string): unknown[] {
    this.buffer += this.decoder.write(chunk);
    const out: unknown[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim().length > 0) out.push(JSON.parse(line));
    }
    return out;
  }
}

export interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

export type RpcMessage = RpcResponse | RpcEvent;

let nextId = 0;

/**
 * Client over a ChildProcess stdio pair. Commands get id-correlated response
 * promises; protocol events are emitted on "event". The child's stderr is
 * surfaced on "stderr" (never parsed).
 */
export class RpcClient extends EventEmitter {
  private decoder = new JsonlDecoder();
  private pending = new Map<
    string,
    { resolve: (r: RpcResponse) => void; reject: (e: Error) => void }
  >();

  constructor(private child: ChildProcess) {
    super();
    child.stdout!.on("data", (chunk: Buffer) => {
      for (const msg of this.decoder.push(chunk)) this.handle(msg as RpcMessage);
    });
    child.stderr!.on("data", (chunk: Buffer) => this.emit("stderr", String(chunk)));
    child.once("exit", (code) => {
      for (const [, p] of this.pending) p.reject(new Error(`child exited (${code})`));
      this.pending.clear();
      this.emit("exit", code);
    });
  }

  private handle(msg: RpcMessage): void {
    if (msg.type === "response" && typeof msg.id === "string") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.resolve(msg);
      }
      return;
    }
    this.emit("event", msg);
  }

  send(command: Record<string, unknown>, timeoutMs = 10_000): Promise<RpcResponse> {
    const id = `gw_${nextId++}`;
    const wire = JSON.stringify({ ...command, id }) + "\n";
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${String(command.type)}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin!.write(wire);
    });
  }
}
```

- [ ] **Step 4: Run framing tests to verify pass**

Run: `pnpm --filter @aelvyril/gateway test`
Expected: PASS (13 tests: 9 + 4 framing).

- [ ] **Step 5: Create the fake child** — `apps/gateway/fixtures/fake-pi.mjs`

```js
// Scripted `pi --mode rpc` stand-in for tests/dev (Phase 1). Speaks the
// documented protocol: one response per command, then a fixed event sequence.
import readline from "node:readline"; // fake child MAY use readline — it IS a mock
import { setTimeout as sleep } from "node:timers/promises";

const rl = readline.createInterface({ input: process.stdin });
const delay = Number(process.env.FAKE_DELAY_MS ?? 5);

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

for await (const line of rl) {
  if (!line.trim()) continue;
  const cmd = JSON.parse(line);
  send({ id: cmd.id, type: "response", command: cmd.type, success: true });
  if (cmd.type === "prompt") {
    send({ type: "turn_start" });
    send({ type: "message_start", message: { role: "assistant" } });
    for (const delta of ["Hello", ", ", "world", "!"]) {
      await sleep(delay);
      send({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta, contentIndex: 0 },
      });
    }
    await sleep(delay);
    send({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: { path: "/tmp/x" },
    });
    send({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "read",
      isError: false,
    });
    send({ type: "message_end", message: { role: "assistant" } });
    send({ type: "turn_end", toolResults: [] });
    send({ type: "agent_end", messages: [], willRetry: false });
    send({ type: "agent_settled" });
  } else if (cmd.type === "abort") {
    send({ type: "agent_settled" });
  }
}
```

- [ ] **Step 6: Client ↔ fake child integration test** — append to `apps/gateway/src/rpc.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RpcClient } from "./rpc.js";

const fakePi = fileURLToPath(new URL("../fixtures/fake-pi.mjs", import.meta.url));

describe("RpcClient over fake child", () => {
  it("correlates the response and streams protocol events", async () => {
    const child = spawn(process.execPath, [fakePi]);
    const rpc = new RpcClient(child);
    const events: RpcEvent[] = [];
    rpc.on("event", (e: RpcEvent) => events.push(e));
    const res = await rpc.send({ type: "prompt", message: "hi" });
    expect(res.success).toBe(true);
    await vi.waitFor(() => {
      expect(events.map((e) => e.type)).toContain("agent_settled");
    });
    expect(events.some((e) => e.type === "message_update")).toBe(true);
    child.kill();
  });
});
```

(Note: add `import { vi } from "vitest"` to the existing vitest import at the top of the file.)

- [ ] **Step 7: Run all gateway tests**

Run: `pnpm --filter @aelvyril/gateway test`
Expected: PASS (14 tests).

- [ ] **Step 8: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): strict JSONL RPC client + scripted fake pi child"
```

---

### Task 4: Supervisor — child lifecycle + envelope mapping

**Files:**
- Create: `apps/gateway/src/supervisor.ts`
- Test: `apps/gateway/src/supervisor.test.ts`

- [ ] **Step 1: Write failing tests** — `apps/gateway/src/supervisor.test.ts`

```ts
import { afterEach, describe, expect, it } from "vitest";
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
    spawnChild: () => {
      const child = spawn(process.execPath, [fakePi]);
      return child;
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
    const conv = store.createConversation({});
    const seen: EventEnvelope[] = [];
    const done = new Promise<void>((resolve) => {
      bus.subscribe(conv.id, (e) => {
        seen.push(e);
        if (e.kind === "session_state" && e.payload.state === "idle") resolve();
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
    expect(seen.map((e) => e.seq)).toEqual([...seen.map((e) => e.seq)].sort((a, b) => a - b));
    expect(store.getConversation(conv.id)?.state).toBe("idle");
    const deltas = seen
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.payload as { delta: string }).delta)
      .join("");
    expect(deltas).toBe("Hello, world!");
  });

  it("marks degraded when the child dies, then recovers on next prompt", async () => {
    const { store, bus, supervisor } = makeSupervisor();
    s = supervisor;
    const conv = store.createConversation({});
    await supervisor.prompt(conv.id, "hi"); // session up, settled, idle
    supervisor.killChild(conv.id); // simulate crash
    await new Promise((r) => setTimeout(r, 50));
    expect(store.getConversation(conv.id)?.state).toBe("degraded");
    const ok = await supervisor.prompt(conv.id, "again"); // respawn
    expect(ok).toBe(true);
    expect(store.getConversation(conv.id)?.state).toBe("idle");
  });

  it("replays nothing for a fresh conversation", () => {
    const { bus, store } = makeSupervisor();
    const conv = store.createConversation({});
    expect(bus.replay(conv.id, -1)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @aelvyril/gateway test`
Expected: FAIL — `./supervisor.js` not found.

- [ ] **Step 3: Implement supervisor** — `apps/gateway/src/supervisor.ts`

```ts
import { spawn, type ChildProcess } from "node:child_process";
import type { EventEnvelope } from "@aelvyril/shared";
import { RpcClient, type RpcEvent } from "./rpc.js";
import type { EventBus } from "./bus.js";
import type { Store } from "./store.js";

export interface SupervisorOptions {
  bus: EventBus;
  store: Store;
  spawnChild: () => ChildProcess;
  idleMs: number;
}

interface Handle {
  rpc: RpcClient;
  child: ChildProcess;
  lastActivity: number;
  exiting: boolean;
}

/**
 * One RPC child process per conversation (spec D6). Normalizes protocol
 * events into EventEnvelopes, persists + fans out via the bus, and owns the
 * lifecycle: spawn-on-demand, idle reap, crash → degraded (respawn on next
 * prompt from the pi session file in Phase 3).
 */
export class Supervisor {
  private handles = new Map<string, Handle>();
  private reaper: NodeJS.Timeout;

  constructor(private opts: SupervisorOptions) {
    this.reaper = setInterval(() => this.reapIdle(), Math.min(opts.idleMs, 5_000));
    this.reaper.unref();
  }

  has(conversationId: string): boolean {
    return this.handles.has(conversationId);
  }

  private ensureSession(conversationId: string): Handle {
    const existing = this.handles.get(conversationId);
    if (existing) return existing;
    const child = this.opts.spawnChild();
    const rpc = new RpcClient(child);
    const handle: Handle = { rpc, child, lastActivity: Date.now(), exiting: false };
    rpc.on("event", (ev: RpcEvent) => this.onProtocolEvent(conversationId, ev));
    rpc.on("exit", () => {
      if (handle.exiting) return;
      this.handles.delete(conversationId);
      this.opts.store.setConversationState(conversationId, "degraded");
      this.publish(conversationId, { kind: "session_state", payload: { state: "degraded" } });
    });
    this.handles.set(conversationId, handle);
    return handle;
  }

  async prompt(
    conversationId: string,
    message: string,
    streamingBehavior?: "steer" | "followUp",
  ): Promise<boolean> {
    const handle = this.ensureSession(conversationId);
    this.opts.store.setConversationState(conversationId, "streaming");
    this.publish(conversationId, { kind: "session_state", payload: { state: "streaming" } });
    handle.lastActivity = Date.now();
    const command: Record<string, unknown> = { type: "prompt", message };
    if (streamingBehavior) command.streamingBehavior = streamingBehavior;
    const res = await handle.rpc.send(command);
    return res.success;
  }

  async abort(conversationId: string): Promise<boolean> {
    const handle = this.handles.get(conversationId);
    if (!handle) return false;
    handle.lastActivity = Date.now();
    const res = await handle.rpc.send({ type: "abort" });
    return res.success;
  }

  killChild(conversationId: string): void {
    const handle = this.handles.get(conversationId);
    if (!handle) return;
    handle.child.kill("SIGKILL");
  }

  private onProtocolEvent(conversationId: string, ev: RpcEvent): void {
    const handle = this.handles.get(conversationId);
    if (handle) handle.lastActivity = Date.now();

    if (ev.type === "message_update") {
      const ame = ev.assistantMessageEvent as
        | { type?: string; delta?: string }
        | undefined;
      if (ame?.type === "text_delta" && typeof ame.delta === "string") {
        this.publish(conversationId, { kind: "text_delta", payload: { delta: ame.delta } });
      }
      return;
    }
    if (ev.type === "tool_execution_start") {
      this.publish(conversationId, {
        kind: "tool_call",
        payload: {
          toolCallId: String(ev.toolCallId),
          toolName: String(ev.toolName),
          args: ev.args,
        },
      });
      return;
    }
    if (ev.type === "tool_execution_end") {
      this.publish(conversationId, {
        kind: "tool_result",
        payload: { toolCallId: String(ev.toolCallId), isError: Boolean(ev.isError) },
      });
      return;
    }
    if (ev.type === "agent_settled") {
      this.opts.store.setConversationState(conversationId, "idle");
      this.publish(conversationId, { kind: "session_state", payload: { state: "idle" } });
      return;
    }
    if (ev.type === "extension_error") {
      this.publish(conversationId, {
        kind: "error",
        payload: { message: `extension error in ${String(ev.extensionPath)}` },
      });
    }
  }

  private publish(
    conversationId: string,
    part: Pick<EventEnvelope, "kind" | "payload">,
  ): void {
    this.opts.bus.publish({ conversationId, ts: new Date().toISOString(), ...part });
  }

  private reapIdle(): void {
    const now = Date.now();
    for (const [id, handle] of this.handles) {
      if (now - handle.lastActivity > this.opts.idleMs) {
        handle.exiting = true;
        handle.child.kill("SIGTERM");
        this.handles.delete(id);
      }
    }
  }

  disposeAll(): void {
    clearInterval(this.reaper);
    for (const [, handle] of this.handles) {
      handle.exiting = true;
      handle.child.kill("SIGTERM");
    }
    this.handles.clear();
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @aelvyril/gateway test`
Expected: PASS (17 tests: 14 + 3 supervisor).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src
git commit -m "feat(gateway): session supervisor with envelope mapping (spec D6, §6)"
```

---

### Task 5: HTTP layer — v1 routes + SSE

**Files:**
- Modify: `apps/gateway/src/app.ts` (full composition)
- Test: `apps/gateway/src/routes.test.ts`
- Test: `apps/gateway/src/sse.test.ts`

- [ ] **Step 1: Write failing route tests** — `apps/gateway/src/routes.test.ts`

```ts
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildApp, type App } from "./app.js";

const fakePi = fileURLToPath(new URL("../fixtures/fake-pi.mjs", import.meta.url));

function makeApp() {
  const app = buildApp({
    dbPath: ":memory:",
    childCommand: process.execPath,
    childArgs: [fakePi],
    idleMs: 60_000,
  });
  return app;
}

describe("v1 routes", () => {
  let app: App | undefined;
  afterEach(async () => app && (await app.close()));

  it("creates, lists, gets conversations", async () => {
    app = makeApp();
    const created = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      payload: { title: "t", workspace: "LaPis" },
    });
    expect(created.statusCode).toBe(201);
    const conv = created.json();
    expect(conv.id).toMatch(/^conv_/);

    const list = await app.inject({ method: "GET", url: "/v1/conversations" });
    expect(list.json().conversations).toHaveLength(1);

    const one = await app.inject({ method: "GET", url: `/v1/conversations/${conv.id}` });
    expect(one.json().title).toBe("t");

    const missing = await app.inject({ method: "GET", url: "/v1/conversations/conv_x" });
    expect(missing.statusCode).toBe(404);
  });

  it("validates prompt body", async () => {
    app = makeApp();
    const conv = (
      await app.inject({ method: "POST", url: "/v1/conversations", payload: {} })
    ).json();
    const bad = await app.inject({
      method: "POST",
      url: `/v1/conversations/${conv.id}/prompt`,
      payload: { message: "" },
    });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: "POST",
      url: "/v1/conversations/conv_x/prompt",
      payload: { message: "hi" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("accepts a prompt and returns 202", async () => {
    app = makeApp();
    const conv = (
      await app.inject({ method: "POST", url: "/v1/conversations", payload: {} })
    ).json();
    const res = await app.inject({
      method: "POST",
      url: `/v1/conversations/${conv.id}/prompt`,
      payload: { message: "hi" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true });
    await vi.waitFor(async () => {
      const one = await app!.inject({ method: "GET", url: `/v1/conversations/${conv.id}` });
      expect(one.json().state).toBe("idle");
    });
  });

  it("abort on unknown conversation 404s", async () => {
    app = makeApp();
    const res = await app.inject({ method: "POST", url: "/v1/conversations/conv_x/abort" });
    expect(res.statusCode).toBe(404);
  });
});
```

(Note: add `vi` to the vitest import.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @aelvyril/gateway test`
Expected: FAIL — routes not implemented (404s).

- [ ] **Step 3: Compose the full app** — replace `apps/gateway/src/app.ts`

```ts
import Fastify, { type FastifyInstance } from "fastify";
import { PromptBody, CreateConversationBody, EventEnvelope } from "@aelvyril/shared";
import { Store } from "./store.js";
import { EventBus } from "./bus.js";
import { Supervisor } from "./supervisor.js";
import { spawn } from "node:child_process";

export interface AppOptions {
  dbPath: string;
  childCommand: string;
  childArgs: string[];
  idleMs?: number;
}

export type App = FastifyInstance & { close: () => Promise<void> };

export function buildApp(opts: AppOptions): App {
  const app = Fastify({ logger: false });
  const store = new Store(opts.dbPath);
  const bus = new EventBus(store);
  const supervisor = new Supervisor({
    bus,
    store,
    spawnChild: () => spawn(opts.childCommand, opts.childArgs),
    idleMs: opts.idleMs ?? 300_000,
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/v1/conversations", async (req, reply) => {
    const body = CreateConversationBody.parse(req.body ?? {});
    const conv = store.createConversation(body);
    return reply.code(201).send(conv);
  });

  app.get("/v1/conversations", async () => ({ conversations: store.listConversations() }));

  app.get("/v1/conversations/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const conv = store.getConversation(id);
    return conv ? conv : reply.code(404).send({ error: "not_found" });
  });

  app.post("/v1/conversations/:id/prompt", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getConversation(id)) return reply.code(404).send({ error: "not_found" });
    const body = PromptBody.parse(req.body ?? {});
    const ok = await supervisor.prompt(id, body.message, body.streamingBehavior);
    if (!ok) return reply.code(502).send({ error: "agent_rejected" });
    return reply.code(202).send({ accepted: true });
  });

  app.post("/v1/conversations/:id/abort", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getConversation(id)) return reply.code(404).send({ error: "not_found" });
    await supervisor.abort(id);
    return reply.code(202).send({ accepted: true });
  });

  app.get("/v1/conversations/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getConversation(id)) return reply.code(404).send({ error: "not_found" });

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    reply.raw.write("retry: 2000\n\n");

    const lastEventId = Number(req.headers["last-event-id"] ?? "-1");
    let lastSeq = Number.isFinite(lastEventId) ? lastEventId : -1;

    const writeEnvelope = (env: EventEnvelope) => {
      if (env.seq <= lastSeq) return;
      lastSeq = env.seq;
      reply.raw.write(
        `id: ${env.seq}\nevent: ${env.kind}\ndata: ${JSON.stringify(env)}\n\n`,
      );
    };

    for (const env of bus.replay(id, lastSeq)) writeEnvelope(env);

    let heartbeat: NodeJS.Timeout | undefined;
    const unsubscribe = bus.subscribe(id, (env) => writeEnvelope(env));
    heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);

    req.raw.on("close", () => {
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    });
  });

  app.addHook("onClose", async () => {
    supervisor.disposeAll();
    store.close();
  });

  return app as App;
}
```

- [ ] **Step 4: Run route tests to verify pass**

Run: `pnpm --filter @aelvyril/gateway test`
Expected: PASS (21 tests: 17 + 4 route).

- [ ] **Step 5: Write the SSE integration test** — `apps/gateway/src/sse.test.ts`

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import type { EventEnvelope } from "@aelvyril/shared";

const fakePi = fileURLToPath(new URL("../fixtures/fake-pi.mjs", import.meta.url));

describe("SSE end-to-end", () => {
  const app = buildApp({
    dbPath: ":memory:",
    childCommand: process.execPath,
    childArgs: [fakePi],
    idleMs: 60_000,
  });
  let baseUrl = "";

  beforeAll(async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => app.close());

  it("streams envelopes for a prompt, in order, then settles", async () => {
    const conv = (
      await (
        await fetch(`${baseUrl}/v1/conversations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      ).json()
    ) as { id: string };

    const stream = await fetch(`${baseUrl}/v1/conversations/${conv.id}/events`);
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const nextEnvelope = async (): Promise<EventEnvelope> => {
      for (;;) {
        const idx = buffer.indexOf("\n\n");
        if (idx !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const data = block
            .split("\n")
            .find((l) => l.startsWith("data: "))!
            .slice(6);
          return JSON.parse(data) as EventEnvelope;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buffer += decoder.decode(value, { stream: true });
      }
    };

    // kick off the prompt after the stream is open
    const promptPromise = fetch(`${baseUrl}/v1/conversations/${conv.id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });

    const seen: EventEnvelope[] = [];
    for (;;) {
      const env = await nextEnvelope();
      seen.push(env);
      if (env.kind === "session_state" && env.payload.state === "idle") break;
    }
    await promptPromise;

    expect(seen[0]!.kind).toBe("session_state");
    expect(seen.map((e) => e.seq)).toEqual([...new Set(seen.map((e) => e.seq))].sort((a, b) => a - b));
    const text = seen
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e.payload as { delta: string }).delta)
      .join("");
    expect(text).toBe("Hello, world!");
  });

  it("replays from Last-Event-ID on reconnect", async () => {
    const conv = (
      await (
        await fetch(`${baseUrl}/v1/conversations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      ).json()
    ) as { id: string };
    await fetch(`${baseUrl}/v1/conversations/${conv.id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    await new Promise((r) => setTimeout(r, 100));

    const replay = await fetch(`${baseUrl}/v1/conversations/${conv.id}/events`, {
      headers: { "last-event-id": "6" },
    });
    const body = await replay.text();
    expect(body).toContain("event: session_state"); // the final idle event (seq 7)
    expect(body).not.toContain("event: text_delta"); // seqs 1-4 skipped
  });
});
```

- [ ] **Step 6: Run the full gateway suite**

Run: `pnpm --filter @aelvyril/gateway test`
Expected: PASS (23 tests: 21 + 2 SSE).

- [ ] **Step 7: Commit**

```bash
git add apps/gateway/src
git commit -m "feat(gateway): v1 routes + SSE with Last-Event-ID replay (spec §6)"
```

---

### Task 6: Entrypoint polish + full verification

**Files:**
- Modify: `apps/gateway/src/index.ts` (graceful shutdown, fake-child dev switch)
- Create: `apps/gateway/README.md`

- [ ] **Step 1: Final `apps/gateway/src/index.ts`**

```ts
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";

const port = Number(process.env.GATEWAY_PORT ?? 8787);
const useFakeChild = process.env.PI_FAKE === "1";

const app = buildApp({
  dbPath: process.env.GATEWAY_DB ?? "./data/gateway.db",
  childCommand: useFakeChild ? process.execPath : (process.env.PI_COMMAND ?? "pi"),
  childArgs: useFakeChild
    ? [fileURLToPath(new URL("../fixtures/fake-pi.mjs", import.meta.url))]
    : ["--mode", "rpc"],
  idleMs: Number(process.env.GATEWAY_IDLE_MS ?? 300_000),
});

await app.listen({ port, host: "127.0.0.1" });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
```

- [ ] **Step 2: Create `apps/gateway/README.md`**

```md
# @aelvyril/gateway

Agent platform gateway (spec: `docs/superpowers/specs/2026-09-22-aelvyril-agent-platform-design.md` §6).

Owns: conversation records, per-conversation RPC session hosts, the event log
(SQLite, WAL), and the SSE stream with Last-Event-ID replay.

## Run (dev, fake child — no pi needed)

    GATEWAY_PORT=8787 PI_FAKE=1 pnpm --filter @aelvyril/gateway dev

## Run (real pi session hosts — Phase 3)

    GATEWAY_PORT=8787 PI_COMMAND=pi pnpm --filter @aelvyril/gateway dev

## Env

| Var | Default | Meaning |
|---|---|---|
| `GATEWAY_PORT` | `8787` | listen port (loopback) |
| `GATEWAY_DB` | `./data/gateway.db` | SQLite path (WAL) |
| `PI_FAKE` | unset | `1` = use the scripted fake child |
| `PI_COMMAND` | `pi` | session host command (real mode) |
| `GATEWAY_IDLE_MS` | `300000` | idle session reap timeout |
```

- [ ] **Step 3: Full verification from repo root**

Run: `pnpm -r typecheck && pnpm -r lint && pnpm -r test`
Expected: all green — 17 shared tests + 23 gateway tests = 40 total.

- [ ] **Step 4: Smoke the real server end-to-end (fake child)**

```bash
GATEWAY_PORT=8791 PI_FAKE=1 GATEWAY_DB=$(mktemp -d)/gw.db pnpm --filter @aelvyril/gateway start &
sleep 2
curl -s localhost:8791/healthz
curl -s -X POST localhost:8791/v1/conversations -H 'content-type: application/json' -d '{"title":"smoke"}'
kill %1
```
Expected: `{"ok":true}` and a conversation JSON.

- [ ] **Step 5: Commit + push**

```bash
git add apps/gateway
git commit -m "feat(gateway): entrypoint with graceful shutdown + fake-child dev mode"
git push origin main
```
