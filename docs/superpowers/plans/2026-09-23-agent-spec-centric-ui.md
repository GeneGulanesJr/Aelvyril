# Agent Spec-Centric UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Use Sequential mode for planned tasks or Direct mode if subagents aren't available. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the chat-first frontend with a spec-centric UI where every ask produces a plan + diff; non-trivial asks auto-trigger an agent-driven spec interview before execution.

**Architecture:** New SSE envelopes (`spec_question`, `spec_draft`, `spec_status`, `diff`) flow from a thin `agent-contract.ts` wrapper around the existing PiAgent session hosts. The frontend grows a `components/thread/*` family that renders Plan / Trace / Diff tabs. Backend changes are minimal: schema migration adds 4 columns, 4 new HTTP routes, and the conversation list is renamed to threads.

**Tech Stack:** Fastify (gateway), zod (shared types), better-sqlite3 (storage), Next.js + React + Tailwind v4 (web), SSE for streaming, vitest for tests.

**Spec:** `docs/superpowers/specs/2026-09-23-agent-spec-centric-ui-redesign.md` (commit `8dbd073`).

---

## File Structure

**Backend (gateway):**
- `apps/gateway/src/store.ts` — MODIFY: add status columns + spec blob accessors
- `apps/gateway/src/store.test.ts` — MODIFY: tests for new columns + accessors
- `apps/gateway/src/agent-contract.ts` — NEW: wraps session host, emits spec envelopes
- `apps/gateway/src/agent-contract.test.ts` — NEW
- `apps/gateway/src/spec-heuristic.ts` — NEW: decides spec mode trigger
- `apps/gateway/src/spec-heuristic.test.ts` — NEW
- `apps/gateway/src/app.ts` — MODIFY: 4 new routes + conversations→threads rename + 302 alias
- `apps/gateway/src/app.test.ts` — MODIFY: tests for new routes
- `apps/gateway/src/index.ts` — MODIFY: run migration on startup

**Shared:**
- `packages/shared/src/api.ts` — MODIFY: SpecQuestion, SpecDraft, ThreadStatus, extended PromptBody, Thread extends Conversation
- `packages/shared/src/api.test.ts` — MODIFY: tests
- `packages/shared/src/envelope.ts` — MODIFY: 4 new EventEnvelope variants
- `packages/shared/src/envelope.test.ts` — MODIFY
- `packages/shared/src/index.ts` — MODIFY: export new types

**Frontend (web):**
- `apps/web/app/thread/[id]/page.tsx` — NEW: thread view
- `apps/web/app/thread/new/page.tsx` — NEW: empty state
- `apps/web/app/page.tsx` — MODIFY: redirect to /thread/new
- `apps/web/app/chat/page.tsx` — NEW: 302 redirect to /thread/new
- `apps/web/lib/api.ts` — MODIFY: add createThread, listThreads, patchSpec, approveSpec, abandonThread, retryThread
- `apps/web/lib/api.test.ts` — MODIFY
- `apps/web/lib/sse.ts` — MODIFY: handle new envelope types
- `apps/web/lib/sse.test.ts` — MODIFY
- `apps/web/lib/use-thread.ts` — NEW: SSE connection + spec session state
- `apps/web/lib/use-thread.test.ts` — NEW
- `apps/web/components/thread/header.tsx` — NEW
- `apps/web/components/thread/sidebar.tsx` — NEW
- `apps/web/components/thread/input.tsx` — NEW
- `apps/web/components/thread/spec-session.tsx` — NEW
- `apps/web/components/thread/output-tabs.tsx` — NEW
- `apps/web/components/thread/plan-tab.tsx` — NEW
- `apps/web/components/thread/trace-tab.tsx` — NEW
- `apps/web/components/thread/diff-tab.tsx` — NEW
- `apps/web/components/chat.tsx` — DELETE
- `apps/web/components/chat.test.tsx` — DELETE (replaced by thread tests)
- `apps/web/lib/filter-conversations.ts` — DELETE (no longer needed)

**Tests:**
- `e2e/spec-mode.spec.ts` — NEW: Playwright spec flow
- `e2e/casual-ask.spec.ts` — NEW: Playwright casual flow

**Docs:**
- `docs/ops/gateway.md` — MODIFY: add /v1/threads/* routes
- `docs/superpowers/plans/2026-09-22-phase2-web-chat.md` — MODIFY: STATUS reflects UI pivot
- `README.md` — MODIFY: mention agent spec-centric UI as v1 surface

---

## Slice 1: Schema + Shared Types (the contract everything else builds on)

### Task 1: SQLite migration for thread status + spec blobs

**Files:**
- Modify: `apps/gateway/src/store.ts` (add migration helper + column accessors)
- Modify: `apps/gateway/src/store.test.ts` (test migration is idempotent)

- [ ] **Step 1: Write failing test for migration**

In `apps/gateway/src/store.test.ts`, add:

```ts
describe("thread columns migration", () => {
  it("adds status + spec columns idempotently", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "store-mig-"));
    const db = openDb(join(tmp, "test.db"));
    runMigrations(db);
    // Re-running must not throw.
    runMigrations(db);
    const cols = db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("status");
    expect(names).toContain("spec_draft");
    expect(names).toContain("spec_questions");
    expect(names).toContain("spec_answers");
    rmSync(tmp, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aelvyril/gateway test store.test.ts -t "migration"`
Expected: FAIL — `runMigrations` is not defined.

- [ ] **Step 3: Implement migration**

In `apps/gateway/src/store.ts`, add at module top:

```ts
export function runMigrations(db: Database): void {
  const cols = db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("status")) {
    db.exec("ALTER TABLE conversations ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'");
  }
  if (!names.has("spec_draft")) {
    db.exec("ALTER TABLE conversations ADD COLUMN spec_draft TEXT");
  }
  if (!names.has("spec_questions")) {
    db.exec("ALTER TABLE conversations ADD COLUMN spec_questions TEXT");
  }
  if (!names.has("spec_answers")) {
    db.exec("ALTER TABLE conversations ADD COLUMN spec_answers TEXT");
  }
}
```

Import `Database` from `better-sqlite3` (existing import).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aelvyril/gateway test store.test.ts -t "migration"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/store.ts apps/gateway/src/store.test.ts
git commit -m "feat(store): thread status + spec blob columns (idempotent migration)"
```

### Task 2: Shared types — SpecQuestion, SpecDraft, ThreadStatus

**Files:**
- Modify: `packages/shared/src/api.ts`
- Modify: `packages/shared/src/api.test.ts`

- [ ] **Step 1: Write failing tests**

In `packages/shared/src/api.test.ts`, add:

```ts
import { SpecQuestion, SpecDraft, ThreadStatus } from "./api.js";

describe("SpecQuestion", () => {
  it("parses a text question", () => {
    const q = SpecQuestion.parse({ id: "q1", prompt: "What roles?", kind: "text" });
    expect(q.id).toBe("q1");
    expect(q.kind).toBe("text");
  });
  it("parses a select question with options", () => {
    const q = SpecQuestion.parse({ id: "q2", prompt: "Auth?", kind: "select", options: ["existing", "new"] });
    expect(q.options).toEqual(["existing", "new"]);
  });
});

describe("SpecDraft", () => {
  it("round-trips through JSON", () => {
    const d: SpecDraft = {
      goal: "add RBAC",
      filesAffected: ["apps/web/auth.ts"],
      plan: ["add role enum", "wire middleware"],
      risks: ["breaks existing users"],
      questions: [{ id: "q1", prompt: "Roles?", kind: "text" }],
      answers: { q1: "admin, editor" },
    };
    expect(SpecDraft.parse(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });
});

describe("ThreadStatus", () => {
  it("accepts all 6 statuses", () => {
    for (const s of ["draft", "spec'ing", "running", "reviewed", "merged", "abandoned"] as const) {
      expect(ThreadStatus.parse(s)).toBe(s);
    }
  });
  it("rejects unknown status", () => {
    expect(() => ThreadStatus.parse("bogus")).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @aelvyril/shared test api.test.ts -t "Spec"`
Expected: FAIL — SpecQuestion, SpecDraft, ThreadStatus undefined.

- [ ] **Step 3: Implement types**

In `packages/shared/src/api.ts`, add (before the existing `Conversation` export):

```ts
export const SpecQuestion = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  kind: z.enum(["text", "select", "multiselect"]),
  options: z.array(z.string()).optional(),
});
export type SpecQuestion = z.infer<typeof SpecQuestion>;

export const SpecDraft = z.object({
  goal: z.string(),
  filesAffected: z.array(z.string()),
  plan: z.array(z.string()),
  risks: z.array(z.string()),
  questions: z.array(SpecQuestion),
  answers: z.record(z.string(), z.string()),
});
export type SpecDraft = z.infer<typeof SpecDraft>;

export const ThreadStatus = z.enum(["draft", "spec'ing", "running", "reviewed", "merged", "abandoned"]);
export type ThreadStatus = z.infer<typeof ThreadStatus>;

export const PatchSpecBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("answer"), answers: z.record(z.string(), z.string()) }),
  z.object({
    kind: z.literal("edit"),
    field: z.enum(["goal", "filesAffected", "plan", "risks"]),
    value: z.union([z.string(), z.array(z.string())]),
  }),
]);
export type PatchSpecBody = z.infer<typeof PatchSpecBody>;
```

Then extend `Conversation` (rename to `Thread` alias while keeping backward-compat):

```ts
export const Thread = Conversation.extend({
  status: ThreadStatus,
  specDraft: SpecDraft.nullable(),
  specQuestions: z.array(SpecQuestion),
  specAnswers: z.record(z.string(), z.string()),
});
export type Thread = z.infer<typeof Thread>;
```

And extend `PromptBody`:

```ts
export const PromptBody = z.object({
  prompt: z.string().min(1),
  workspace: z.string().optional(),
  specMode: z.enum(["auto", "force", "off"]).default("auto"),
});
export type PromptBody = z.infer<typeof PromptBody>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @aelvyril/shared test api.test.ts`
Expected: PASS (existing tests + new 4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/api.ts packages/shared/src/api.test.ts
git commit -m "feat(shared): SpecQuestion, SpecDraft, ThreadStatus, PatchSpecBody types"
```

### Task 3: SSE envelopes for spec mode

**Files:**
- Modify: `packages/shared/src/envelope.ts`
- Modify: `packages/shared/src/envelope.test.ts`
- Modify: `packages/shared/src/index.ts` (export new types)

- [ ] **Step 1: Write failing tests**

In `packages/shared/src/envelope.test.ts`, add:

```ts
import { parseEnvelope } from "./envelope.js";

describe("spec envelopes", () => {
  it("parses spec_question", () => {
    const e = parseEnvelope(JSON.stringify({
      type: "spec_question",
      threadId: "t1",
      questions: [{ id: "q1", prompt: "Roles?", kind: "text" }],
    }));
    expect(e?.type).toBe("spec_question");
  });
  it("parses spec_draft", () => {
    const e = parseEnvelope(JSON.stringify({
      type: "spec_draft", threadId: "t1",
      draft: { goal: "x", filesAffected: [], plan: [], risks: [], questions: [], answers: {} },
    }));
    expect(e?.type).toBe("spec_draft");
  });
  it("parses spec_status", () => {
    const e = parseEnvelope(JSON.stringify({ type: "spec_status", threadId: "t1", status: "running" }));
    expect(e?.type).toBe("spec_status");
  });
  it("parses diff", () => {
    const e = parseEnvelope(JSON.stringify({ type: "diff", threadId: "t1", files: [{ path: "a.ts", patch: "@@ ..." }] }));
    expect(e?.type).toBe("diff");
  });
  it("returns null for unknown type", () => {
    expect(parseEnvelope(JSON.stringify({ type: "bogus" }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @aelvyril/shared test envelope.test.ts -t "spec"`
Expected: FAIL — parseEnvelope doesn't handle new types.

- [ ] **Step 3: Implement**

In `packages/shared/src/envelope.ts`, extend the union:

```ts
import { z } from "zod";
import { SpecQuestion, SpecDraft, ThreadStatus } from "./api.js";

export const SpecQuestionEvent = z.object({
  type: z.literal("spec_question"),
  threadId: z.string(),
  questions: z.array(SpecQuestion),
});
export const SpecDraftEvent = z.object({
  type: z.literal("spec_draft"),
  threadId: z.string(),
  draft: SpecDraft,
});
export const SpecStatusEvent = z.object({
  type: z.literal("spec_status"),
  threadId: z.string(),
  status: ThreadStatus,
});
export const DiffEvent = z.object({
  type: z.literal("diff"),
  threadId: z.string(),
  files: z.array(z.object({ path: z.string(), patch: z.string() })),
});

export const EventEnvelope = z.discriminatedUnion("type", [
  // existing message envelope(s) here — keep them
  SpecQuestionEvent,
  SpecDraftEvent,
  SpecStatusEvent,
  DiffEvent,
]);
export type EventEnvelope = z.infer<typeof EventEnvelope>;

export function parseEnvelope(raw: string): EventEnvelope | null {
  try {
    const json = JSON.parse(raw);
    const parsed = EventEnvelope.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
```

Preserve any existing envelope types already exported (the current file may have `MessageEnvelope` etc.). Extend the union rather than replacing.

In `packages/shared/src/index.ts`, add exports:

```ts
export type { SpecQuestion, SpecDraft, ThreadStatus, PatchSpecBody, Thread } from "./api.js";
export { SpecQuestion, SpecDraft, ThreadStatus, PatchSpecBody, Thread } from "./api.js";
export { EventEnvelope, parseEnvelope, SpecQuestionEvent, SpecDraftEvent, SpecStatusEvent, DiffEvent } from "./envelope.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @aelvyril/shared test`
Expected: PASS (existing 18 + new 5 = 23)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/envelope.ts packages/shared/src/envelope.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): spec_question/spec_draft/spec_status/diff SSE envelopes"
```

---

## Slice 2: Spec Heuristic (decides when to trigger interview)

### Task 4: Spec heuristic module

**Files:**
- Create: `apps/gateway/src/spec-heuristic.ts`
- Create: `apps/gateway/src/spec-heuristic.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "vitest";
import { shouldEnterSpecMode } from "./spec-heuristic.js";

describe("shouldEnterSpecMode", () => {
  it("off mode never triggers", () => {
    expect(shouldEnterSpecMode("rename x to y", "off")).toBe(false);
  });
  it("force mode always triggers", () => {
    expect(shouldEnterSpecMode("rename x to y", "force")).toBe(true);
  });
  it("auto: short single-file rename does not trigger", () => {
    expect(shouldEnterSpecMode("rename getUserById to findUserById", "auto")).toBe(false);
  });
  it("auto: multi-feature ask triggers", () => {
    expect(shouldEnterSpecMode("add role-based access to admin dashboard", "auto")).toBe(true);
  });
  it("auto: long single sentence triggers", () => {
    const prompt = "build a complete authentication system with login, logout, password reset, email verification, OAuth integration, and admin role management that supports multiple tenants";
    expect(shouldEnterSpecMode(prompt, "auto")).toBe(true);
  });
  it("auto: 2+ imperative verbs trigger", () => {
    expect(shouldEnterSpecMode("add a button and integrate the payment flow", "auto")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @aelvyril/gateway test spec-heuristic.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/gateway/src/spec-heuristic.ts
type SpecMode = "auto" | "force" | "off";

const FEATURE_WORDS = /\b(file|files|system|feature|features|page|pages|screen|screens|endpoint|endpoints|model|models|schema|table|tables|column|columns|route|routes|component|components|module|modules)\b/gi;
const IMPERATIVE_VERBS = /\b(build|create|add|integrate|implement|setup|configure|migrate|refactor|rewrite|design|develop|deploy|wire|connect|scaffold|generate)\b/gi;
const SENTENCE_TERMINATOR = /[.!?](\s|$)/;

const HEURISTIC_OFF = process.env.GATEWAY_SPEC_HEURISTIC === "off";

export function shouldEnterSpecMode(prompt: string, mode: SpecMode): boolean {
  if (mode === "off" || HEURISTIC_OFF) return false;
  if (mode === "force") return true;
  // auto mode:
  const featureHits = (prompt.match(FEATURE_WORDS) ?? []).length;
  const verbHits = (prompt.match(IMPERATIVE_VERBS) ?? []).length;
  const isSingleSentence = !SENTENCE_TERMINATOR.test(prompt);
  return featureHits >= 2 || verbHits >= 2 || (isSingleSentence && prompt.length > 200);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @aelvyril/gateway test spec-heuristic.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/spec-heuristic.ts apps/gateway/src/spec-heuristic.test.ts
git commit -m "feat(gateway): spec-mode heuristic (off/force/auto)"
```

---

## Slice 3: Agent Contract (wraps session host, emits spec events)

### Task 5: agent-contract.ts skeleton + event types

**Files:**
- Create: `apps/gateway/src/agent-contract.ts`
- Create: `apps/gateway/src/agent-contract.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { AgentContract } from "./agent-contract.js";
import { EventEmitter } from "node:events";

function fakeSession() {
  const ee = new EventEmitter();
  return {
    stdin: { write: vi.fn() } as unknown as NodeJS.WritableStream,
    stdout: ee as unknown as NodeJS.ReadableStream & EventEmitter,
    stderr: new EventEmitter() as unknown as NodeJS.ReadableStream & EventEmitter,
    on: ee.on.bind(ee),
    emit: ee.emit.bind(ee),
    pid: 12345,
    kill: vi.fn(),
  };
}

describe("AgentContract", () => {
  it("emits spec_status and spec_question when spec mode triggers", () => {
    const session = fakeSession();
    const c = new AgentContract(session, { specMode: "force" });
    const status: string[] = [];
    const questions: unknown[] = [];
    c.on("envelope", (e) => {
      if (e.type === "spec_status") status.push(e.status);
      if (e.type === "spec_question") questions.push(e.questions);
    });
    c.start();
    // Simulate the agent emitting a spec_question JSON line on stdout.
    session.emit("data", Buffer.from(JSON.stringify({
      type: "spec_question", questions: [{ id: "q1", prompt: "?", kind: "text" }],
    }) + "\n"));
    expect(status).toContain("spec'ing");
    expect(questions).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aelvyril/gateway test agent-contract.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement skeleton**

```ts
// apps/gateway/src/agent-contract.ts
import { EventEmitter } from "node:events";
import { shouldEnterSpecMode } from "./spec-heuristic.js";
import type { EventEnvelope, PatchSpecBody } from "@aelvyril/shared";

export interface AgentContractOptions {
  specMode: "auto" | "force" | "off";
  threadId: string;
  workspace?: string;
}

export class AgentContract extends EventEmitter {
  private opts: AgentContractOptions;
  private session: { stdout: NodeJS.ReadableStream; stdin: NodeJS.WritableStream; kill(): void; pid?: number };
  private inSpecMode = false;
  private currentDraft: import("@aelvyril/shared").SpecDraft | null = null;
  private currentQuestions: import("@aelvyril/shared").SpecQuestion[] = [];
  private specRounds = 0;
  private stdoutBuf = "";

  constructor(session: AgentContractOptions extends never ? never : any, opts: AgentContractOptions) {
    super();
    this.session = session;
    this.opts = opts;
  }

  start(prompt: string): void {
    const enterSpec = shouldEnterSpecMode(prompt, this.opts.specMode);
    this.inSpecMode = enterSpec;
    this.session.stdout.on("data", (chunk: Buffer | string) => this.onStdout(chunk));
    if (enterSpec) {
      this.emitStatus("spec'ing");
      this.sendToAgent({ type: "system", message: "Enter spec-interview mode. First emit spec_question with 2-5 questions covering: (a) goal clarity, (b) scope boundaries, (c) constraints. Do not emit spec_draft until all questions are answered. Max 3 question rounds, then escalate per spec §6 step 2." });
    } else {
      this.emitStatus("running");
      this.sendToAgent({ type: "user", prompt });
    }
  }

  submitSpecPatch(body: PatchSpecBody): void {
    if (body.kind === "answer") {
      this.specRounds++;
      if (!this.currentDraft) this.currentDraft = emptyDraft();
      this.currentDraft = { ...this.currentDraft, answers: { ...this.currentDraft.answers, ...body.answers } };
      this.sendToAgent({ type: "user", message: `Updated answers: ${JSON.stringify(body.answers)}. If all questions answered, emit spec_draft. If still ambiguous, emit another spec_question round.` });
    } else {
      // edit
      if (!this.currentDraft) this.currentDraft = emptyDraft();
      (this.currentDraft as any)[body.field] = body.value;
      this.emitEnvelope({ type: "spec_draft", threadId: this.opts.threadId, draft: this.currentDraft });
      this.sendToAgent({ type: "user", message: `User edited spec field "${body.field}": ${JSON.stringify(body.value)}` });
    }
  }

  approve(): void {
    this.emitStatus("running");
    this.sendToAgent({ type: "user", message: "Spec approved. Execute the plan. Emit message events for execution trace and a single diff event on completion." });
  }

  abandon(): void {
    this.emitStatus("abandoned");
    try { this.session.kill(); } catch { /* already dead */ }
  }

  retry(): void {
    this.emitStatus("running");
    this.sendToAgent({ type: "user", message: "Retry the execution against the same spec." });
  }

  private onStdout(chunk: Buffer | string): void {
    this.stdoutBuf += chunk.toString();
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      try {
        const env = JSON.parse(line);
        if (env && typeof env === "object" && "type" in env) {
          this.handleAgentEnvelope(env);
        }
      } catch { /* non-JSON stdout from agent — ignore */ }
    }
  }

  private handleAgentEnvelope(env: any): void {
    if (env.type === "spec_question") {
      this.currentQuestions = env.questions ?? [];
      this.emitEnvelope({ type: "spec_question", threadId: this.opts.threadId, questions: this.currentQuestions });
    } else if (env.type === "spec_draft") {
      this.currentDraft = env.draft;
      this.emitEnvelope({ type: "spec_draft", threadId: this.opts.threadId, draft: this.currentDraft });
    } else if (env.type === "message") {
      this.emitEnvelope({ ...env, threadId: this.opts.threadId });
    } else if (env.type === "diff") {
      this.emitEnvelope({ type: "diff", threadId: this.opts.threadId, files: env.files ?? [] });
      this.emitStatus("reviewed");
    } else if (env.type === "error") {
      this.emitEnvelope({ type: "message", threadId: this.opts.threadId, role: "assistant", content: env.message ?? "agent error" });
      this.emitStatus("reviewed");
    }
  }

  private emitEnvelope(e: EventEnvelope): void { this.emit("envelope", e); }
  private emitStatus(s: import("@aelvyril/shared").ThreadStatus): void {
    this.emitEnvelope({ type: "spec_status", threadId: this.opts.threadId, status: s });
  }
  private sendToAgent(msg: unknown): void {
    this.session.stdin.write(JSON.stringify(msg) + "\n");
  }
}

function emptyDraft(): import("@aelvyril/shared").SpecDraft {
  return { goal: "", filesAffected: [], plan: [], risks: [], questions: [], answers: {} };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aelvyril/gateway test agent-contract.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/agent-contract.ts apps/gateway/src/agent-contract.test.ts
git commit -m "feat(gateway): AgentContract wraps session host, emits spec envelopes"
```

---

## Slice 4: Backend Routes (rename + 4 new routes)

### Task 6: Rename /v1/conversations → /v1/threads + 302 alias

**Files:**
- Modify: `apps/gateway/src/app.ts` (existing routes)
- Modify: `apps/gateway/src/app.test.ts`

- [ ] **Step 1: Write failing test**

In `apps/gateway/src/app.test.ts`, add:

```ts
describe("route aliases", () => {
  it("302s GET /v1/conversations to /v1/threads", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/conversations", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/v1/threads");
  });
  it("serves GET /v1/threads", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/threads", headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aelvyril/gateway test app.test.ts -t "aliases"`
Expected: FAIL — /v1/threads doesn't exist.

- [ ] **Step 3: Modify routes**

In `apps/gateway/src/app.ts`, rename all occurrences of `/v1/conversations` to `/v1/threads` for the canonical route, then add an alias:

```ts
// Canonical route:
app.get("/v1/threads", async (req, reply) => { /* existing list logic, returning Thread[] */ });
// Alias for back-compat:
app.get("/v1/conversations", async (_req, reply) => reply.redirect(302, "/v1/threads"));
```

Repeat for POST `/v1/threads`, GET/PATCH/DELETE `/v1/threads/:id`. Add a 302 alias for each.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aelvyril/gateway test app.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/app.ts apps/gateway/src/app.test.ts
git commit -m "refactor(gateway): /v1/conversations -> /v1/threads (302 alias for back-compat)"
```

### Task 7: PATCH /v1/threads/:id/spec

**Files:**
- Modify: `apps/gateway/src/app.ts`
- Modify: `apps/gateway/src/app.test.ts`

- [ ] **Step 1: Write failing test**

```ts
describe("PATCH /v1/threads/:id/spec", () => {
  it("applies an answer patch and persists answers", async () => {
    const t = await createTestThread();
    const res = await app.inject({
      method: "PATCH", url: `/v1/threads/${t.id}/spec`,
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      payload: { kind: "answer", answers: { q1: "admin" } },
    });
    expect(res.statusCode).toBe(200);
    const stored = dbGetThread(t.id);
    expect(JSON.parse(stored.specAnswers!)).toEqual({ q1: "admin" });
  });
  it("applies an edit patch and persists the draft field", async () => {
    const t = await createTestThread({ specDraft: { goal: "", filesAffected: [], plan: [], risks: [], questions: [], answers: {} } });
    const res = await app.inject({
      method: "PATCH", url: `/v1/threads/${t.id}/spec`,
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      payload: { kind: "edit", field: "goal", value: "add RBAC" },
    });
    expect(res.statusCode).toBe(200);
    const stored = dbGetThread(t.id);
    expect(JSON.parse(stored.specDraft!).goal).toBe("add RBAC");
  });
  it("rejects malformed body with 400", async () => {
    const t = await createTestThread();
    const res = await app.inject({
      method: "PATCH", url: `/v1/threads/${t.id}/spec`,
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      payload: { kind: "answer" },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aelvyril/gateway test app.test.ts -t "PATCH"`
Expected: FAIL — route not registered.

- [ ] **Step 3: Implement route**

In `apps/gateway/src/app.ts`:

```ts
import { PatchSpecBody } from "@aelvyril/shared";
import type { AgentContract } from "./agent-contract.js";

app.patch<{ Params: { id: string }; Body: unknown }>("/v1/threads/:id/spec", async (req, reply) => {
  const userId = await user(req, reply);
  if (!userId) return;
  const parsed = PatchSpecBody.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
  const thread = store.getThread(req.params.id);
  if (!thread || thread.userId !== userId) return reply.code(404).send({ error: "not_found" });
  if (parsed.data.kind === "answer") {
    store.mergeSpecAnswers(thread.id, parsed.data.answers);
  } else {
    store.patchSpecDraft(thread.id, parsed.data.field, parsed.data.value);
  }
  // Forward to live contract if session is running.
  const contract = activeContracts.get(thread.id);
  if (contract) contract.submitSpecPatch(parsed.data);
  return { ok: true };
});
```

Add `store.mergeSpecAnswers` and `store.patchSpecDraft` helpers in `store.ts` that update the corresponding columns and parse/serialize JSON blobs.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aelvyril/gateway test app.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/app.ts apps/gateway/src/app.test.ts apps/gateway/src/store.ts
git commit -m "feat(gateway): PATCH /v1/threads/:id/spec with discriminated body"
```

### Task 8: POST /v1/threads/:id/approve, abandon, retry

**Files:**
- Modify: `apps/gateway/src/app.ts`
- Modify: `apps/gateway/src/app.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
describe("thread lifecycle routes", () => {
  it("POST /approve transitions spec'ing -> running", async () => {
    const t = await createTestThread({ status: "spec'ing" });
    const res = await app.inject({ method: "POST", url: `/v1/threads/${t.id}/approve`, headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    expect(dbGetThread(t.id).status).toBe("running");
  });
  it("POST /abandon marks abandoned", async () => {
    const t = await createTestThread({ status: "running" });
    const res = await app.inject({ method: "POST", url: `/v1/threads/${t.id}/abandon`, headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    expect(dbGetThread(t.id).status).toBe("abandoned");
  });
  it("POST /retry transitions reviewed -> running", async () => {
    const t = await createTestThread({ status: "reviewed" });
    const res = await app.inject({ method: "POST", url: `/v1/threads/${t.id}/retry`, headers: { authorization: "Bearer good" } });
    expect(res.statusCode).toBe(200);
    expect(dbGetThread(t.id).status).toBe("running");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aelvyril/gateway test app.test.ts -t "lifecycle"`
Expected: FAIL

- [ ] **Step 3: Implement routes**

In `apps/gateway/src/app.ts`, add three routes. Each looks up the contract (if active) and forwards:

```ts
app.post<{ Params: { id: string } }>("/v1/threads/:id/approve", async (req, reply) => {
  const userId = await user(req, reply);
  if (!userId) return;
  const thread = store.getThread(req.params.id);
  if (!thread || thread.userId !== userId) return reply.code(404).send({ error: "not_found" });
  store.updateStatus(thread.id, "running");
  activeContracts.get(thread.id)?.approve();
  return { ok: true };
});

app.post<{ Params: { id: string } }>("/v1/threads/:id/abandon", async (req, reply) => {
  const userId = await user(req, reply);
  if (!userId) return;
  const thread = store.getThread(req.params.id);
  if (!thread || thread.userId !== userId) return reply.code(404).send({ error: "not_found" });
  store.updateStatus(thread.id, "abandoned");
  activeContracts.get(thread.id)?.abandon();
  return { ok: true };
});

app.post<{ Params: { id: string } }>("/v1/threads/:id/retry", async (req, reply) => {
  const userId = await user(req, reply);
  if (!userId) return;
  const thread = store.getThread(req.params.id);
  if (!thread || thread.userId !== userId) return reply.code(404).send({ error: "not_found" });
  store.updateStatus(thread.id, "running");
  activeContracts.get(thread.id)?.retry();
  return { ok: true };
});
```

Add `activeContracts: Map<string, AgentContract>` at module scope in `app.ts`. The supervisor hooks into it when sessions are spawned (existing supervisor logic; add contract creation in supervisor's session-start callback).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aelvyril/gateway test app.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/app.ts apps/gateway/src/app.test.ts
git commit -m "feat(gateway): thread lifecycle routes (approve/abandon/retry)"
```

### Task 9: Run migration on gateway startup

**Files:**
- Modify: `apps/gateway/src/index.ts`

- [ ] **Step 1: Add call to `runMigrations`**

In `apps/gateway/src/index.ts`, before `buildApp()`:

```ts
import { runMigrations, openStore } from "./store.js";

const store = openStore();
runMigrations(store.db);
const app = await buildApp({ store, /* other deps */ });
```

- [ ] **Step 2: Run gateway locally**

Run: `pnpm --filter @aelvyril/gateway start`
Expected: gateway starts; `sqlite3 ~/.aelvyril/gateway.db ".schema conversations"` shows 4 new columns.

- [ ] **Step 3: Commit**

```bash
git add apps/gateway/src/index.ts
git commit -m "feat(gateway): run schema migration on startup"
```

---

## Slice 5: Frontend — GatewayClient + SSE extensions

### Task 10: Extend GatewayClient with new methods

**Files:**
- Modify: `apps/web/lib/api.ts`
- Modify: `apps/web/lib/api.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
describe("thread client methods", () => {
  it("createThread POSTs to /v1/threads", async () => {
    const { client, fetchMock } = makeClient();
    mockFetchSequence([{ ok: true, body: { id: "t1", status: "draft" } }]);
    const t = await client.createThread();
    expect(t.id).toBe("t1");
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe("http://example.test/v1/threads");
    expect((call[1] as RequestInit).method).toBe("POST");
  });
  it("listThreads GETs /v1/threads", async () => {
    const { client } = makeClient();
    mockFetchSequence([{ ok: true, body: { threads: [] } }]);
    const out = await client.listThreads();
    expect(out).toEqual([]);
  });
  it("patchSpec answer PATCHes with kind=answer", async () => {
    const { client } = makeClient();
    mockFetchSequence([{ ok: true, body: { ok: true } }]);
    await client.patchSpec("t1", { kind: "answer", answers: { q1: "admin" } });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ kind: "answer", answers: { q1: "admin" } });
  });
  it("approveSpec/abandonThread/retryThread POST to lifecycle routes", async () => {
    const { client } = makeClient();
    mockFetchSequence([{ ok: true, body: { ok: true } }, { ok: true, body: { ok: true } }, { ok: true, body: { ok: true } }]);
    await client.approveSpec("t1");
    await client.abandonThread("t1");
    await client.retryThread("t1");
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([
      "http://example.test/v1/threads/t1/approve",
      "http://example.test/v1/threads/t1/abandon",
      "http://example.test/v1/threads/t1/retry",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aelvyril/web test lib/api.test.ts -t "thread client"`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Implement**

In `apps/web/lib/api.ts`, add:

```ts
async createThread(): Promise<Thread> {
  const res = await fetch(`${this.baseUrl}/v1/threads`, await this.authed({ method: "POST" }));
  if (!res.ok) throw new Error(`create thread failed: ${res.status}`);
  return (await res.json()) as Thread;
}
async listThreads(): Promise<Thread[]> {
  const res = await fetch(`${this.baseUrl}/v1/threads`, await this.authed());
  if (!res.ok) throw new Error(`list threads failed: ${res.status}`);
  return ((await res.json()) as { threads: Thread[] }).threads;
}
async patchSpec(threadId: string, body: PatchSpecBody): Promise<void> {
  const res = await fetch(`${this.baseUrl}/v1/threads/${threadId}/spec`,
    await this.authed({ method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
  if (!res.ok) throw new Error(`patch spec failed: ${res.status}`);
}
async approveSpec(threadId: string): Promise<void> {
  const res = await fetch(`${this.baseUrl}/v1/threads/${threadId}/approve`, await this.authed({ method: "POST" }));
  if (!res.ok) throw new Error(`approve failed: ${res.status}`);
}
async abandonThread(threadId: string): Promise<void> {
  const res = await fetch(`${this.baseUrl}/v1/threads/${threadId}/abandon`, await this.authed({ method: "POST" }));
  if (!res.ok) throw new Error(`abandon failed: ${res.status}`);
}
async retryThread(threadId: string): Promise<void> {
  const res = await fetch(`${this.baseUrl}/v1/threads/${threadId}/retry`, await this.authed({ method: "POST" }));
  if (!res.ok) throw new Error(`retry failed: ${res.status}`);
}
```

Import `Thread, PatchSpecBody` from `@aelvyril/shared`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aelvyril/web test lib/api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/api.ts apps/web/lib/api.test.ts
git commit -m "feat(web): GatewayClient thread methods (create/list/patch/approve/abandon/retry)"
```

### Task 11: Extend SseParser for spec envelopes

**Files:**
- Modify: `apps/web/lib/sse.ts`
- Modify: `apps/web/lib/sse.test.ts`

- [ ] **Step 1: Write failing test**

```ts
it("emits spec_question/spec_draft/spec_status/diff envelopes", () => {
  const events: string[] = [];
  const parser = new SseParser((e) => events.push(e.type));
  parser.feed('event: message\ndata: {"type":"spec_status","threadId":"t1","status":"spec\'ing"}\n\n');
  parser.feed('event: message\ndata: {"type":"spec_question","threadId":"t1","questions":[]}\n\n');
  parser.feed('event: message\ndata: {"type":"spec_draft","threadId":"t1","draft":{}}\n\n');
  parser.feed('event: message\ndata: {"type":"diff","threadId":"t1","files":[]}\n\n');
  expect(events).toEqual(["spec_status", "spec_question", "spec_draft", "diff"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aelvyril/web test lib/sse.test.ts`
Expected: FAIL — parser filters unknown types.

- [ ] **Step 3: Update parser**

In `apps/web/lib/sse.ts`, replace the type filter to use the shared envelope schema:

```ts
import { parseEnvelope } from "@aelvyril/shared";

private handleData(data: string): void {
  const env = parseEnvelope(data);
  if (env) this.onEvent(env);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aelvyril/web test lib/sse.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/sse.ts apps/web/lib/sse.test.ts
git commit -m "feat(web): SseParser accepts all spec-mode envelopes"
```

### Task 12: useThread hook

**Files:**
- Create: `apps/web/lib/use-thread.ts`
- Create: `apps/web/lib/use-thread.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useThread } from "./use-thread.js";

vi.mock("./api.js", () => ({
  GatewayClient: vi.fn().mockImplementation(() => ({
    prompt: vi.fn(),
    patchSpec: vi.fn(),
    approveSpec: vi.fn(),
  })),
}));

describe("useThread", () => {
  it("exposes thread state + actions", () => {
    const { result } = renderHook(() => useThread("t1"));
    expect(result.current.status).toBe("draft");
    expect(typeof result.current.ask).toBe("function");
    expect(typeof result.current.submitAnswers).toBe("function");
    expect(typeof result.current.approve).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aelvyril/web test use-thread.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/web/lib/use-thread.ts
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { GatewayClient } from "./api.js";
import type { EventEnvelope, SpecDraft, SpecQuestion, ThreadStatus } from "@aelvyril/shared";

export interface ThreadState {
  status: ThreadStatus;
  questions: SpecQuestion[];
  draft: SpecDraft | null;
  plan: string[];
  trace: string[];
  diff: { path: string; patch: string }[];
  error: string | null;
}

export function useThread(threadId: string | null): ThreadState & {
  ask: (prompt: string, specMode: "auto" | "force" | "off") => Promise<void>;
  submitAnswers: (answers: Record<string, string>) => Promise<void>;
  editSpec: (field: "goal" | "filesAffected" | "plan" | "risks", value: string | string[]) => Promise<void>;
  approve: () => Promise<void>;
  abandon: () => Promise<void>;
  retry: () => Promise<void>;
} {
  const [state, setState] = useState<ThreadState>({
    status: "draft", questions: [], draft: null, plan: [], trace: [], diff: [], error: null,
  });
  const clientRef = useRef<GatewayClient | null>(null);

  useEffect(() => {
    if (!threadId) return;
    const token = localStorage.getItem("__token"); // Clerk provides via getToken; pass through
    const client = new GatewayClient(process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787", async () => token);
    clientRef.current = client;
    const es = new EventSource(`${client.baseUrl}/v1/threads/${threadId}/events`, { withCredentials: true });
    const parser = new SseParser((e: EventEnvelope) => {
      setState((s) => applyEnvelope(s, e));
    });
    es.onmessage = (ev) => parser.feed(ev.data);
    return () => es.close();
  }, [threadId]);

  const ask = useCallback(async (prompt: string, specMode: "auto" | "force" | "off") => {
    if (!clientRef.current || !threadId) return;
    await clientRef.current.prompt(threadId, { prompt, specMode });
  }, [threadId]);

  const submitAnswers = useCallback(async (answers: Record<string, string>) => {
    if (!clientRef.current || !threadId) return;
    await clientRef.current.patchSpec(threadId, { kind: "answer", answers });
  }, [threadId]);

  const editSpec = useCallback(async (field: "goal" | "filesAffected" | "plan" | "risks", value: string | string[]) => {
    if (!clientRef.current || !threadId) return;
    await clientRef.current.patchSpec(threadId, { kind: "edit", field, value });
  }, [threadId]);

  const approve = useCallback(async () => {
    if (!clientRef.current || !threadId) return;
    await clientRef.current.approveSpec(threadId);
  }, [threadId]);

  const abandon = useCallback(async () => {
    if (!clientRef.current || !threadId) return;
    await clientRef.current.abandonThread(threadId);
  }, [threadId]);

  const retry = useCallback(async () => {
    if (!clientRef.current || !threadId) return;
    await clientRef.current.retryThread(threadId);
  }, [threadId]);

  return { ...state, ask, submitAnswers, editSpec, approve, abandon, retry };
}

function applyEnvelope(s: ThreadState, e: EventEnvelope): ThreadState {
  switch (e.type) {
    case "spec_status": return { ...s, status: e.status };
    case "spec_question": return { ...s, questions: e.questions };
    case "spec_draft": return { ...s, draft: e.draft, plan: e.draft.plan };
    case "message": return { ...s, trace: [...s.trace, e.content] };
    case "diff": return { ...s, diff: e.files };
    default: return s;
  }
}
```

Add `prompt(threadId, body)` to `GatewayClient` (already exists; alias if needed).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aelvyril/web test use-thread.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/use-thread.ts apps/web/lib/use-thread.test.ts
git commit -m "feat(web): useThread hook + envelope reducer"
```

---

## Slice 6: Frontend — Thread Components

### Task 13: components/thread/sidebar.tsx

**Files:**
- Create: `apps/web/components/thread/sidebar.tsx`
- Create: `apps/web/components/thread/sidebar.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ThreadSidebar } from "./sidebar.js";
import type { Thread } from "@aelvyril/shared";

const threads: Thread[] = [
  { id: "t1", title: "add RBAC", workspace: null, state: "idle", createdAt: "2026-09-23T00:00:00.000Z", status: "spec'ing", specDraft: null, specQuestions: [], specAnswers: {} },
  { id: "t2", title: "fix typo", workspace: null, state: "idle", createdAt: "2026-09-22T00:00:00.000Z", status: "merged", specDraft: null, specQuestions: [], specAnswers: {} },
];

describe("ThreadSidebar", () => {
  it("renders threads with status pills", () => {
    render(<ThreadSidebar threads={threads} activeId="t1" onSelect={() => {}} onCreate={() => {}} />);
    expect(screen.getByText("add RBAC")).toBeTruthy();
    expect(screen.getByText("fix typo")).toBeTruthy();
    expect(screen.getAllByTestId("status-pill")[0]).toHaveTextContent("spec'ing");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aelvyril/web test sidebar.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// apps/web/components/thread/sidebar.tsx
"use client";
import type { Thread, ThreadStatus } from "@aelvyril/shared";

const STATUS_COLORS: Record<ThreadStatus, string> = {
  draft: "bg-[#2b3245] text-[#8b96a8]",
  "spec'ing": "bg-[#e3b341]/20 text-[#e3b341]",
  running: "bg-[#1f6feb]/20 text-[#1f6feb]",
  reviewed: "bg-[#3fb950]/20 text-[#3fb950]",
  merged: "bg-[#3fb950]/10 text-[#3fb950]/60",
  abandoned: "bg-[#f85149]/20 text-[#f85149]",
};

export function ThreadSidebar({ threads, activeId, onSelect, onCreate }: {
  threads: Thread[]; activeId: string | null;
  onSelect: (id: string) => void; onCreate: () => void;
}) {
  return (
    <aside className="flex w-64 flex-col border-r border-[#2b3245] bg-[#0d1117] p-3 text-sm">
      <button
        className="mb-3 rounded border border-[#2b3245] bg-[#161b27] px-3 py-2 text-left hover:bg-[#21262d]"
        onClick={onCreate}
        data-testid="new-thread"
      >
        + New thread
      </button>
      <ul className="space-y-1">
        {threads.map((t) => (
          <li key={t.id}>
            <button
              className={`flex w-full items-center justify-between rounded px-2 py-1 text-left ${activeId === t.id ? "bg-[#21262d]" : "hover:bg-[#161b27]"}`}
              onClick={() => onSelect(t.id)}
              data-testid={`thread-${t.id}`}
            >
              <span className="truncate">{t.title ?? t.id}</span>
              <span data-testid="status-pill" className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${STATUS_COLORS[t.status]}`}>{t.status}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aelvyril/web test sidebar.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/thread/sidebar.tsx apps/web/components/thread/sidebar.test.tsx
git commit -m "feat(web): ThreadSidebar with status pills"
```

### Task 14: components/thread/input.tsx

**Files:**
- Create: `apps/web/components/thread/input.tsx`
- Create: `apps/web/components/thread/input.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
it("renders Ask and Ask+spec buttons; submits via callback", async () => {
  const ask = vi.fn();
  render(<ThreadInput onAsk={ask} disabled={false} />);
  fireEvent.change(screen.getByTestId("thread-input"), { target: { value: "add RBAC" } });
  fireEvent.click(screen.getByTestId("ask-button"));
  expect(ask).toHaveBeenCalledWith("add RBAC", "auto");
});
it("Ask+spec submits with force mode", () => {
  const ask = vi.fn();
  render(<ThreadInput onAsk={ask} disabled={false} />);
  fireEvent.change(screen.getByTestId("thread-input"), { target: { value: "x" } });
  fireEvent.click(screen.getByTestId("ask-spec-button"));
  expect(ask).toHaveBeenCalledWith("x", "force");
});
```

- [ ] **Step 2-5:** Standard TDD: implement (textarea + 2 buttons calling `onAsk(text, mode)`), test passes, commit.

Implementation:

```tsx
"use client";
import { useState } from "react";

export function ThreadInput({ onAsk, disabled }: { onAsk: (prompt: string, mode: "auto" | "force" | "off") => void; disabled: boolean }) {
  const [text, setText] = useState("");
  return (
    <div className="border-t border-[#2b3245] bg-[#0d1117] p-3">
      <textarea
        className="w-full resize-none rounded border border-[#2b3245] bg-[#161b27] p-2 text-sm focus:border-[#1f6feb] focus:outline-none"
        data-testid="thread-input"
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        placeholder="Ask anything..."
        rows={3}
        value={text}
      />
      <div className="mt-2 flex gap-2">
        <button
          className="rounded bg-[#1f6feb] px-3 py-1 text-sm font-medium disabled:opacity-40"
          data-testid="ask-button"
          disabled={disabled || !text.trim()}
          onClick={() => { onAsk(text, "auto"); setText(""); }}
        >Ask</button>
        <button
          className="rounded border border-[#2b3245] bg-[#161b27] px-3 py-1 text-sm disabled:opacity-40"
          data-testid="ask-spec-button"
          disabled={disabled || !text.trim()}
          onClick={() => { onAsk(text, "force"); setText(""); }}
        >Ask + spec</button>
      </div>
    </div>
  );
}
```

Commit: `git commit -m "feat(web): ThreadInput with Ask / Ask+spec buttons"`

### Task 15: components/thread/spec-session.tsx

**Files:**
- Create: `apps/web/components/thread/spec-session.tsx`
- Create: `apps/web/components/thread/spec-session.test.tsx`

- [ ] **Step 1-5:** Standard TDD.

Test: renders questions stack with input per question, draft spec, and 3 buttons (edit, approve & run, cancel). Submitting answers calls `onSubmitAnswers(answers)`. Editing a field calls `onEditSpec(field, value)`. Approving calls `onApprove()`.

Implementation skeleton (rendering):

```tsx
"use client";
import { useState } from "react";
import type { SpecDraft, SpecQuestion } from "@aelvyril/shared";

export function SpecSession({
  questions, draft, status,
  onSubmitAnswers, onEditSpec, onApprove, onCancel,
}: {
  questions: SpecQuestion[]; draft: SpecDraft | null; status: string;
  onSubmitAnswers: (a: Record<string, string>) => void;
  onEditSpec: (field: "goal" | "filesAffected" | "plan" | "risks", value: string | string[]) => void;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (status !== "spec'ing") return null;

  return (
    <div className="border-t border-[#2b3245] bg-[#0d1117] p-3 text-sm" data-testid="spec-session">
      {questions.length > 0 && (
        <div className="space-y-2">
          {questions.map((q) => (
            <label key={q.id} className="block">
              <span className="block text-[#8b96a8]">{q.prompt}</span>
              {q.kind === "select" && q.options ? (
                <select
                  className="mt-1 w-full rounded border border-[#2b3245] bg-[#161b27] p-1"
                  data-testid={`q-${q.id}`}
                  value={answers[q.id] ?? ""}
                  onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                >
                  <option value="">—</option>
                  {q.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  className="mt-1 w-full rounded border border-[#2b3245] bg-[#161b27] p-1"
                  data-testid={`q-${q.id}`}
                  onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                  value={answers[q.id] ?? ""}
                />
              )}
            </label>
          ))}
          <button
            className="rounded bg-[#1f6feb] px-3 py-1 text-xs"
            data-testid="submit-answers"
            onClick={() => onSubmitAnswers(answers)}
            disabled={questions.some((q) => !answers[q.id])}
          >Submit answers</button>
        </div>
      )}
      {draft && (
        <div className="mt-3 space-y-2 border-t border-[#2b3245] pt-3">
          <SpecField label="Goal" value={draft.goal} onChange={(v) => onEditSpec("goal", v)} testId="spec-goal" />
          <SpecField label="Files" value={draft.filesAffected.join(", ")} onChange={(v) => onEditSpec("filesAffected", v.split(",").map((s) => s.trim()))} testId="spec-files" multiline />
          <SpecField label="Plan" value={draft.plan.join("\n")} onChange={(v) => onEditSpec("plan", v.split("\n"))} testId="spec-plan" multiline />
          <SpecField label="Risks" value={draft.risks.join("\n")} onChange={(v) => onEditSpec("risks", v.split("\n"))} testId="spec-risks" multiline />
          <div className="flex gap-2 pt-2">
            <button className="rounded bg-[#3fb950] px-3 py-1 text-xs font-medium" data-testid="approve" onClick={onApprove}>Approve & run</button>
            <button className="rounded border border-[#2b3245] px-3 py-1 text-xs" onClick={onCancel}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function SpecField({ label, value, onChange, testId, multiline }: { label: string; value: string; onChange: (v: string) => void; testId: string; multiline?: boolean }) {
  return (
    <label className="block">
      <span className="block text-xs text-[#8b96a8]">{label}</span>
      {multiline ? (
        <textarea className="mt-1 w-full rounded border border-[#2b3245] bg-[#161b27] p-1 text-xs" data-testid={testId} onChange={(e) => onChange(e.target.value)} rows={3} value={value} />
      ) : (
        <input className="mt-1 w-full rounded border border-[#2b3245] bg-[#161b27] p-1 text-xs" data-testid={testId} onChange={(e) => onChange(e.target.value)} value={value} />
      )}
    </label>
  );
}
```

Commit: `git commit -m "feat(web): SpecSession with questions stack + editable draft + approve/cancel"`

### Task 16: components/thread/output-tabs.tsx (Plan / Trace / Diff)

**Files:**
- Create: `apps/web/components/thread/output-tabs.tsx`
- Create: `apps/web/components/thread/plan-tab.tsx`
- Create: `apps/web/components/thread/trace-tab.tsx`
- Create: `apps/web/components/thread/diff-tab.tsx`

- [ ] **Step 1-5:** Standard TDD for each tab + the tab bar.

Test pattern (output-tabs.test.tsx):

```tsx
it("switches between Plan / Trace / Diff tabs", () => {
  render(<OutputTabs plan={["step1"]} trace={["hello"]} diff={[{ path: "a.ts", patch: "@@" }]} />);
  expect(screen.getByText("step1")).toBeTruthy();
  fireEvent.click(screen.getByText("Trace"));
  expect(screen.getByText("hello")).toBeTruthy();
  fireEvent.click(screen.getByText("Diff"));
  expect(screen.getByText("a.ts")).toBeTruthy();
});
```

Implementation: simple `useState<string>("plan")` + conditional render.

For `DiffTab`, render each file as a `<details>` with the path as summary, the patch as `<pre>` inside (monospace, color-coded: lines starting with `+` green, `-` red, `@@` blue).

Commit per file: `feat(web): PlanTab/TraceTab/DiffTab/OutputTabs`.

### Task 17: components/thread/header.tsx

**Files:**
- Create: `apps/web/components/thread/header.tsx`
- Create: `apps/web/components/thread/header.test.tsx`

- [ ] **Step 1-5:** Standard TDD.

Test: renders title + status pill + thread menu (rename, abandon).

Implementation:

```tsx
"use client";
import type { Thread } from "@aelvyril/shared";

export function ThreadHeader({ thread, onRename, onAbandon }: { thread: Thread; onRename: (t: string) => void; onAbandon: () => void }) {
  return (
    <header className="flex items-center justify-between border-b border-[#2b3245] bg-[#0d1117] px-4 py-2 text-sm">
      <h1 className="font-semibold">{thread.title ?? "untitled"}</h1>
      <span data-testid="thread-status" className="rounded bg-[#21262d] px-2 py-0.5 text-xs">{thread.status}</span>
      <div className="flex gap-2">
        <button className="text-xs text-[#8b96a8] hover:text-[#e6edf3]" onClick={() => onRename(prompt("New title:") ?? thread.title ?? "")}>rename</button>
        <button className="text-xs text-[#f85149] hover:underline" onClick={onAbandon}>abandon</button>
      </div>
    </header>
  );
}
```

Commit: `git commit -m "feat(web): ThreadHeader with title + status pill + actions"`

---

## Slice 7: Frontend — Page Integration

### Task 18: app/thread/[id]/page.tsx

**Files:**
- Create: `apps/web/app/thread/[id]/page.tsx`

- [ ] **Step 1: Write component-level test**

Create `apps/web/app/thread/[id]/page.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ThreadPage from "./page.js";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "tok", userId: "u1" }), UserButton: () => null }));
vi.mock("../../lib/api.js", () => ({ GatewayClient: vi.fn().mockImplementation(() => ({
  listThreads: vi.fn().mockResolvedValue([]),
})) }));

describe("ThreadPage", () => {
  it("renders sidebar + input + tabs", async () => {
    render(<ThreadPage params={{ id: "t1" }} />);
    expect(await screen.findByTestId("new-thread")).toBeTruthy();
    expect(screen.getByTestId("thread-input")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aelvyril/web test page.test.tsx`
Expected: FAIL — page not found.

- [ ] **Step 3: Implement page**

```tsx
// apps/web/app/thread/[id]/page.tsx
"use client";
import { useEffect, useState } from "react";
import { useAuth, UserButton } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import type { Thread } from "@aelvyril/shared";
import { GatewayClient } from "../../lib/api.js";
import { useThread } from "../../lib/use-thread.js";
import { ThreadSidebar } from "../../components/thread/sidebar.js";
import { ThreadInput } from "../../components/thread/input.js";
import { SpecSession } from "../../components/thread/spec-session.js";
import { OutputTabs } from "../../components/thread/output-tabs.js";
import { ThreadHeader } from "../../components/thread/header.js";

export default function ThreadPage({ params }: { params: { id: string } }) {
  const { getToken, userId } = useAuth();
  const router = useRouter();
  const [client, setClient] = useState<GatewayClient | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await getToken();
      const c = new GatewayClient(process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787", async () => token);
      if (!cancelled) {
        setClient(c);
        try {
          const list = await c.listThreads();
          setThreads(list);
        } catch (err) {
          console.error("listThreads failed", err);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [getToken]);

  const threadState = useThread(params.id === "new" ? null : params.id);

  if (!client) return <div className="p-4 text-[#8b96a8]">loading…</div>;

  const activeThread = threads.find((t) => t.id === params.id);

  return (
    <div className="flex h-screen bg-[#010409] text-[#e6edf3]">
      <ThreadSidebar
        threads={threads}
        activeId={params.id === "new" ? null : params.id}
        onSelect={(id) => router.push(`/thread/${id}`)}
        onCreate={async () => {
          const t = await client.createThread();
          router.push(`/thread/${t.id}`);
        }}
      />
      <main className="flex flex-1 flex-col">
        {activeThread && (
          <ThreadHeader
            thread={activeThread}
            onRename={async (title) => { /* PATCH /v1/threads/:id with title */ }}
            onAbandon={() => threadState.abandon()}
          />
        )}
        {params.id !== "new" && (
          <>
            <OutputTabs plan={threadState.plan} trace={threadState.trace} diff={threadState.diff} />
            <SpecSession
              questions={threadState.questions}
              draft={threadState.draft}
              status={threadState.status}
              onSubmitAnswers={threadState.submitAnswers}
              onEditSpec={threadState.editSpec}
              onApprove={threadState.approve}
              onCancel={() => router.push("/thread/new")}
            />
            <ThreadInput
              onAsk={(prompt, mode) => threadState.ask(prompt, mode)}
              disabled={false}
            />
          </>
        )}
        {params.id === "new" && (
          <div className="flex flex-1 items-center justify-center">
            <ThreadInput
              onAsk={async (prompt, mode) => {
                const t = await client.createThread();
                await client.prompt(t.id, { prompt, specMode: mode });
                router.push(`/thread/${t.id}`);
              }}
              disabled={false}
            />
          </div>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aelvyril/web test page.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/thread/[id]/page.tsx apps/web/app/thread/[id]/page.test.tsx
git commit -m "feat(web): /thread/[id] page with sidebar + input + tabs + spec session"
```

### Task 19: Redirects — /chat, /

**Files:**
- Modify: `apps/web/app/page.tsx`
- Create: `apps/web/app/chat/page.tsx`

- [ ] **Step 1: Add Next.js redirect**

In `apps/web/app/page.tsx`:

```tsx
import { redirect } from "next/navigation";
export default function Page() { redirect("/thread/new"); }
```

In `apps/web/app/chat/page.tsx`:

```tsx
import { redirect } from "next/navigation";
export default function Page() { redirect("/thread/new"); }
```

- [ ] **Step 2: Build + smoke test**

Run: `pnpm --filter @aelvyril/web build`
Then: `curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:3001/`
Expected: 307 (Next redirect) → /thread/new

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/page.tsx apps/web/app/chat/page.tsx
git commit -m "feat(web): redirect / and /chat to /thread/new"
```

### Task 20: Delete legacy chat.tsx + filter-conversations.ts

**Files:**
- Delete: `apps/web/components/chat.tsx`
- Delete: `apps/web/components/chat.test.tsx`
- Delete: `apps/web/lib/filter-conversations.ts`
- Delete: `apps/web/lib/filter-conversations.test.ts`

- [ ] **Step 1: Delete files + remove imports from layout**

Run:
```bash
git rm apps/web/components/chat.tsx apps/web/components/chat.test.tsx apps/web/lib/filter-conversations.ts apps/web/lib/filter-conversations.test.ts
```

In `apps/web/app/layout.tsx`, remove any chat.tsx imports.

- [ ] **Step 2: Run web test suite + typecheck**

Run: `pnpm --filter @aelvyril/web test && pnpm --filter @aelvyril/web typecheck`
Expected: green

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor(web): remove legacy chat UI; spec-centric UI replaces it"
```

---

## Slice 8: Integration + Docs

### Task 21: Playwright e2e — casual ask flow

**Files:**
- Create: `e2e/casual-ask.spec.ts`

- [ ] **Step 1: Write test**

```ts
import { test, expect } from "@playwright/test";

test("casual ask produces plan + diff without spec interview", async ({ page }) => {
  await page.goto("/thread/new");
  await page.getByTestId("thread-input").fill("rename getUserById to findUserById");
  await page.getByTestId("ask-button").click();
  await expect(page.getByText("rename")).toBeVisible(); // Plan tab shows the plan
});
```

- [ ] **Step 2: Run**

Run: `pnpm exec playwright test e2e/casual-ask.spec.ts`
Expected: PASS (with gateway + Clerk dev instance up)

- [ ] **Step 3: Commit**

```bash
git add e2e/casual-ask.spec.ts
git commit -m "test(e2e): casual ask flow produces plan + diff"
```

### Task 22: Playwright e2e — spec mode flow

**Files:**
- Create: `e2e/spec-mode.spec.ts`

- [ ] **Step 1: Write test**

```ts
test("ambiguous ask triggers spec interview", async ({ page }) => {
  await page.goto("/thread/new");
  await page.getByTestId("thread-input").fill("add role-based access to the admin dashboard");
  await page.getByTestId("ask-button").click();
  await expect(page.getByTestId("spec-session")).toBeVisible();
  // Answer one question; submit.
  await page.getByTestId(/^q-/).first().fill("admin, editor, viewer");
  await page.getByTestId("submit-answers").click();
  // Draft should appear.
  await expect(page.getByTestId("spec-goal")).toBeVisible();
});
```

- [ ] **Step 2-3:** Same as Task 21.

Commit: `git commit -m "test(e2e): spec mode interview + answer flow"`

### Task 23: Docs refresh

**Files:**
- Modify: `docs/ops/gateway.md`
- Modify: `docs/superpowers/plans/2026-09-22-phase2-web-chat.md`
- Modify: `README.md`

- [ ] **Step 1: Add /v1/threads routes to gateway runbook**

In `docs/ops/gateway.md`, add a section after the existing /v1/* routes:

```md
## Thread routes (spec-centric UI)

- `GET /v1/threads` — list threads for the authenticated user
- `POST /v1/threads` — create a thread
- `GET /v1/threads/:id` — fetch one thread
- `PATCH /v1/threads/:id/spec` — submit answers (`{kind:"answer"}`) or edit draft (`{kind:"edit"}`)
- `POST /v1/threads/:id/approve` — transition spec'ing → running
- `POST /v1/threads/:id/abandon` — terminal state
- `POST /v1/threads/:id/retry` — re-run from reviewed

Legacy alias: `/v1/conversations*` 302 → `/v1/threads*`. Removed in next release.
```

- [ ] **Step 2: Update phase 2 plan STATUS**

In `docs/superpowers/plans/2026-09-22-phase2-web-chat.md`, replace any "chat-first" language in the STATUS block with "spec-centric UI (plan 2026-09-23)".

- [ ] **Step 3: Update root README**

Add one paragraph under "Status" pointing at the spec.

- [ ] **Step 4: Commit**

```bash
git add docs/ops/gateway.md docs/superpowers/plans/2026-09-22-phase2-web-chat.md README.md
git commit -m "docs: refresh for spec-centric UI (routes, plan status, README)"
```

---

## Self-Review Checklist (run before declaring plan complete)

- [ ] Spec coverage: every decision in spec §3 has at least one task; UX flows in §4 covered by Tasks 13-18; backend events in §5.1 by Tasks 1-5, 7-9; agent contract §6 by Task 5
- [ ] No placeholders: scan for TBD/TODO/"implement later"/"appropriate"; replace with concrete code
- [ ] Type consistency: `Thread`, `PatchSpecBody`, `SpecQuestion`, `SpecDraft`, `ThreadStatus` names match across all tasks
- [ ] Test coverage: every task has at least one test; integration via Tasks 21-22

---

## Final Verification

After all tasks committed:

```bash
pnpm -r test          # expect: ~50 gateway + ~30 web + 23 shared + 3 Playwright = green
pnpm -r typecheck     # expect: clean
```

Then manual smoke:

1. `pnpm --filter @aelvyril/gateway start` (already running from earlier work)
2. `pnpm --filter @aelvyril/web dev`
3. Visit http://localhost:3001 → redirected to /thread/new
4. Type "fix typo in README" → click Ask → see Plan/Trace/Diff tabs populate
5. Type "add RBAC to admin dashboard" → click Ask → see spec session expand
6. Answer questions → see draft spec appear → click Approve & run → see execution + diff
