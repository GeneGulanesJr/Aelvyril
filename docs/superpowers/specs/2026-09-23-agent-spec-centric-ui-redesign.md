# Aelvyril — Agent Spec-Centric UI Redesign

**Date:** 2026-09-23
**Status:** Approved design (`S1 inline expansion, agent-decides threshold, persist forever`)
**Repo:** `~/Documents/GulanesKorp/Aelvyril`
**Supersedes:** chat-first UI in §3 D1 of `2026-09-22-aelvyril-agent-platform-design.md` (UI surface only; backend + ops-later are unaffected)

---

## 1. Summary

The current Aelvyril chat UI was a stand-in for what Aelvyril actually is: a workspace where an agent reads your request, plans, edits files, and emits a diff you review. The chat metaphor forced casual asks and detailed specs into the same thin input — fine for "fix this typo", wrong for "build an admin dashboard with role-based access."

This redesign replaces the chat surface with a **spec-centric UI** where the artifact is always (a) the spec and (b) the diff, regardless of how the user asked. Casual asks still feel casual — the agent just decides when it needs more information and asks 2–5 clarifying questions before executing.

The backend is mostly unchanged: same PiAgent session hosts, same SSE event stream, same workspace allowlist, same SandD sandbox. Two new event envelopes land in the existing stream (`spec_question`, `spec_draft`), one new boolean flag in the prompt request (`specMode: "auto" | "force" | "off"`), and the conversation list becomes a thread list with statuses.

## 2. Goals & Non-Goals

### Goals
1. Casual asks ("fix this typo") feel as light as a chat message — no spec friction.
2. Non-trivial asks automatically produce a **spec + Q&A + plan** the user can edit before execution.
3. The artifact is **always plan + diff** — never just a transcript.
4. Specs persist as first-class threads (resume tomorrow, share, archive).
5. Zero new infra. Reuse PiAgent, SSE, workspace allowlist, SandD, LaPis hooks.

### Non-Goals (v1)
- Multi-agent parallel execution (one agent per thread; the existing model)
- In-browser code editing (the agent edits; the user reviews)
- PR/branch management (the diff lands against the workspace; merge is the user's problem)
- Visual node editor / agent workflow graphs
- Dedicated spec routes (`/spec`); everything is on `/thread/:id`

## 3. Decision Log

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | UX shape | **S1 — inline expansion** | One input box, agent-driven spec session expands inline below. Lowest chrome, scales up only when needed. |
| D2 | Threshold | **Agent-decides, user-overridable** | Prompt carries `specMode: "auto" \| "force" \| "off"`. Default `"auto"`; UI exposes two buttons (`[Ask]` for quick, `[Ask + spec]` to force spec mode). |
| D3 | Persistence | **Persist forever, status-tagged** | Threads (renamed from conversations) carry status `draft \| spec'ing \| running \| reviewed \| merged \| abandoned`. No auto-archive in v1. |
| D4 | Spec source | **Agent-drafted, user-editable** | User never writes a spec from scratch. Agent drafts from answers; user can edit any field before approving. |
| D5 | Spec surface | **Inline accordion** below the input | When in spec mode, the input area expands to show: clarifying questions stack, draft spec, `[approve & run] / [edit] / [cancel]` buttons. |
| D6 | Output surface | **3 tabs: Plan / Trace / Diff** | Below the input+spec area, every thread renders its result in three tabs. Consistent regardless of mode. |
| D7 | Renaming | **`conversations` → `threads`** in API + UI | The unit is no longer a chat conversation; it's a thread (could be 1 message, could be 50 questions + spec + run). **Table name on disk unchanged** in v1 (SQLite migration just adds columns to the existing `conversations` table); a future release may rename the table. |
| D8 | Event envelopes | **Add 4: `spec_question`, `spec_draft`, `spec_status`, `diff`** | New SSE event types in `@aelvyril/shared`. Existing `message` envelope still used for casual execution trace. |
| D9 | Agent contract | **Spec interview triggers on ambiguity heuristics** | Heuristic: spec mode kicks in if (a) user forced it, OR (b) the ask mentions >1 file/system/feature, OR (c) the ask is a single sentence with multiple verbs. Tunable later. |
| D10 | Edit-on-spec | **Allowed, idempotent** | User can edit any spec field after agent drafts; re-submitting the spec re-asks any unresolved questions. |
| D11 | Old chat UI | **Component removed; route 302'd** | `components/chat.tsx` is replaced by `components/thread/*`. The legacy `/chat` route serves a 302 → `/thread/new` for one release so any external links don't 404. After that release the route is deleted. |

## 4. UX Flow

### 4.1 Casual ask
```
User types:    "rename `getUserById` to `findUserById`"
User clicks:   [Ask]
Agent:         (no spec mode — ask is unambiguous, single-file, single edit)
Output tabs:   [Plan] "edit apps/api/src/users.ts: rename function"
               [Trace] execution log
               [Diff]   -function getUserById(...) +function findUserById(...)
```

### 4.2 Spec-mode ask
```
User types:    "add role-based access to the admin dashboard"
User clicks:   [Ask]  (or [Ask + spec] to force)
Agent decides: spec mode (multi-file, multi-verb, ambiguous scope)
Input expands: ┌─ spec session ─────────────────────────────┐
               │ Q1: What roles? (admin, editor, viewer)   │
               │   [text input]                            │
               │ Q2: Existing auth system or new?          │
               │   [select: existing / new / none]         │
               │ Q3: Routes affected?                      │
               │   [text input]                            │
               │ ─────────────────────────────────────     │
               │ Draft spec:                               │
               │   Goal: ...                               │
               │   Files: ...                              │
               │   Plan: ...                               │
               │   Risks: ...                              │
               │ [edit] [approve & run] [cancel]           │
               └──────────────────────────────────────────┘
User fills:    3 answers
Agent updates: draft spec
User clicks:   [approve & run]
Output tabs:   [Plan] full plan
               [Trace] execution log
               [Diff]   multi-file diff
```

### 4.3 Forced spec mode
User clicks `[Ask + spec]` instead of `[Ask]`. Same flow, but the agent always asks questions first regardless of heuristic.

### 4.4 Page structure (single thread)
```
/thread/new                                  → empty state + input
/thread/:id                                  → thread view

┌─────────────────────────────────────────────────────────────┐
│ Header: thread title | status pill | thread menu            │
├─────────────────────────────────────────────────────────────┤
│ Input area:                                                │
│   ┌───────────────────────────────────────────────────────┐ │
│   │ Ask anything...                                      │ │
│   │                                                       │ │
│   └───────────────────────────────────────────────────────┘ │
│   [ Ask ]  [ Ask + spec ]                                   │
│                                                             │
│ ┌─ spec session (visible only when active) ────────────────┐ │
│ │   clarifying questions + draft spec + buttons           │ │
│ └─────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│ Output tabs:  [ Plan ]  [ Trace ]  [ Diff ]                │
│   active tab content fills rest of viewport                 │
└─────────────────────────────────────────────────────────────┘
```

### 4.5 Left sidebar (threads list)
```
Workspaces                                  [+ New thread]
  ▸ Aelvyril                                 
  ▸ LaPis                                    
Threads (in active workspace)                
  ● add role-based access   spec'ing          │
  ◐ rename getUserById     reviewed          │
  ✓ fix typo in README     merged            │
  ○ spike: try SSE         abandoned         │
```

Status pill colors:
- `draft` — gray, no spec yet
- `spec'ing` — amber, agent is asking questions or drafting
- `running` — blue, agent is executing
- `reviewed` — green, ready for review
- `merged` — gray-green, terminal
- `abandoned` — red, terminal

## 5. Architecture

### 5.1 Backend changes (`apps/gateway`, `packages/shared`)

**`packages/shared/src/api.ts`**
- Add `SpecQuestion` zod schema: `{ id: string, prompt: string, kind: "text" | "select" | "multiselect", options?: string[] }`
- Add `SpecDraft` zod schema: `{ goal: string, filesAffected: string[], plan: string[], risks: string[], questions: SpecQuestion[], answers: Record<string,string> }`
- Add `ThreadStatus` enum: `draft | spec'ing | running | reviewed | merged | abandoned`
- Extend `PromptBody` with `specMode: "auto" | "force" | "off"` (default `"auto"`)
- Extend `Conversation` → `Thread` with `status`, `specDraft?`, `specQuestions?`

**`apps/gateway/src/app.ts`**
- New routes:
  - `PATCH /v1/threads/:id/spec` — discriminated by body shape:
    - `{ kind: "answer", answers: Record<string,string> }` — submit answers to outstanding questions
    - `{ kind: "edit", field: "goal" | "filesAffected" | "plan" | "risks", value: string | string[] }` — user edits a drafted spec field directly (does NOT re-trigger Q&A; just updates the draft)
  - `POST /v1/threads/:id/approve` — user approved the spec, transition to `running`, start the agent
  - `POST /v1/threads/:id/abandon` — mark abandoned, kill the session if running
  - `POST /v1/threads/:id/retry` — re-run from `reviewed` (post-failure or post-review-rejection) back to `running`
- Existing routes kept but renamed:
  - `/v1/conversations` → `/v1/threads` (302 alias for back-compat for one release)
- `POST /v1/prompt` reads `specMode`. If `"force"` or `"auto"`+heuristic hit, the agent session is initialized in spec-interview mode.

**`apps/gateway/src/agent-contract.ts` (new)**
- Encapsulates the agent's spec-interview behavior. Sends `spec_question` events when it has a question, `spec_draft` when it has a full draft, awaits `spec` patch responses.
- Heuristic for "auto" mode: spec triggers if any of:
  - prompt mentions >1 of {file, system, feature, page, screen, endpoint, model, schema}
  - prompt contains 2+ imperative verbs (e.g., "build", "add", "integrate", "create")
  - prompt is a single sentence > 200 chars
  - `GATEWAY_SPEC_HEURISTIC=off` disables (forces "off" mode)

**`apps/gateway/src/updater.ts` (no change)** — still works.

**SSE event envelopes added** (in `@aelvyril/shared/src/envelope.ts`):
```ts
// Existing envelope shape: { seq, conversationId, ts, kind, payload }
// New kinds extend EnvelopeKind union; payloads live under `payload`.
const SpecQuestionEvent = z.object({
  seq: z.number().int(),
  conversationId: z.string(),
  ts: z.string().datetime({ offset: true }),
  kind: z.literal("spec_question"),
  payload: z.object({ questions: z.array(SpecQuestion) }),
});
const SpecDraftEvent = z.object({
  seq: z.number().int(),
  conversationId: z.string(),
  ts: z.string().datetime({ offset: true }),
  kind: z.literal("spec_draft"),
  payload: z.object({ draft: SpecDraft }),
});
const SpecStatusEvent = z.object({
  seq: z.number().int(),
  conversationId: z.string(),
  ts: z.string().datetime({ offset: true }),
  kind: z.literal("spec_status"),
  payload: z.object({ status: ThreadStatus }),
});
const DiffEvent = z.object({
  seq: z.number().int(),
  conversationId: z.string(),
  ts: z.string().datetime({ offset: true }),
  kind: z.literal("diff"),
  payload: z.object({ files: z.array(z.object({ path: z.string(), patch: z.string() })) }),
});

// A `parseEnvelope(raw: string): EventEnvelope | null` helper returns `null`
// for malformed/empty/non-JSON input (never throws).
```

### 5.2 Frontend changes (`apps/web`)

**New page** `app/thread/[id]/page.tsx` — replaces `app/page.tsx`
- Server component shell, client component body

**New components:**
- `components/thread/header.tsx` — title + status pill + menu
- `components/thread/input.tsx` — single ask input + `[Ask]` / `[Ask + spec]` buttons
- `components/thread/spec-session.tsx` — inline spec session (questions + draft + buttons)
- `components/thread/output-tabs.tsx` — Plan / Trace / Diff tabs
- `components/thread/plan-tab.tsx` — renders the agent's plan
- `components/thread/trace-tab.tsx` — renders execution log (current message stream, filtered)
- `components/thread/diff-tab.tsx` — renders file diffs (use `diff` lib + simple line-by-line renderer)
- `components/thread/sidebar.tsx` — threads list with status pills

**Reuses:**
- `GatewayClient` extended: `createThread`, `listThreads`, `patchSpec`, `approveSpec`, `abandonThread`
- `SseParser` extended to handle new envelope types
- `useThread` hook (new) — manages SSE connection + spec session state

**Removed:**
- `components/chat.tsx` (renamed/replaced by thread components above)
- `app/page.tsx` becomes `/thread/new`

### 5.3 Visual contract (no Tailwind config changes)

Status pills, diff viewer, and tab bar all use the existing dark theme tokens (`bg-[#0d1117]`, `border-[#2b3245]`, accents `#1f6feb` / `#3fb950` / `#e3b341` / `#f85149`). Monaco editor is **not** included in v1 — diffs render as plain unified-diff text with line-level highlighting.

## 6. Agent Behavior Contract

The agent (running inside the PiAgent session host) MUST follow this contract when in spec mode:

1. **First response on spec mode entry:** emit `spec_question` with 2–5 questions covering: (a) goal clarity, (b) scope boundaries, (c) constraints. Do not emit a `spec_draft` until all questions have answers.
2. **On answer receipt (`PATCH /v1/threads/:id/spec` with `{ kind: "answer", answers: {...} }`):** update internal state. If all questions answered, emit `spec_draft`. If answers reveal ambiguity, emit another `spec_question` round (max 3 rounds, then **escalate** = emit a final `spec_draft` with the unanswered questions listed verbatim in the `risks` field, set thread status to `spec'ing` with a visible "answers needed" banner, and wait for the user to either supply answers via `PATCH ... { kind: "answer" }` OR directly edit the draft via `PATCH ... { kind: "edit" }`).
3. **On `POST /v1/threads/:id/approve`:** transition thread to `running`, begin execution. Emit `message` envelopes for the execution trace as today. On completion emit a single `diff` envelope with all changed files (empty array if no files changed). On failure mid-execution, transition to `reviewed` with status pill red-bordered, emit a `message` envelope carrying the error, leave partial `diff` if any. User can then `retry` (→ `running`) or `abandon` (→ terminal).
4. **On execution failure:** emit a `message` envelope with error, leave thread in `reviewed` status (not `merged`). User can retry or abandon.
5. **Off mode (`specMode: "off"`):** skip spec interview entirely, execute immediately, emit `message` + `diff` as today.

The agent prompts carry a system message instructing this behavior. The contract is enforced by `apps/gateway/src/agent-contract.ts` which wraps the agent's stdout and translates events.

## 7. Persistence

- Existing SQLite schema for conversations keeps working. Add columns:
  - `status TEXT NOT NULL DEFAULT 'draft'`
  - `spec_draft TEXT` (JSON blob)
  - `spec_questions TEXT` (JSON blob)
  - `spec_answers TEXT` (JSON blob)
- Migration is a one-shot `ALTER TABLE` on startup (idempotent — checks column existence first).
- Threads persist forever. No archival in v1. Storage cost is small (spec drafts are < 10KB JSON).

## 8. Out of Scope (deferred)

- Multi-agent per thread (parallel sub-agents within one workspace)
- In-browser file editing (Monaco)
- PR/branch lifecycle (create branch, push, open PR via gh CLI)
- Persistent multi-user collaboration on a single thread (real-time cursors)
- Agent-generated test plans / acceptance criteria execution
- LayaMCP-driven UI flows for spec negotiation

## 9. Open Questions

None at design time. Defaults chosen in §3 are the answers.

---

## Appendix A: Status transitions

```
                   ┌──────────┐
                   │  draft   │ (thread created, no prompt yet)
                   └────┬─────┘
                        │ POST /v1/prompt (auto|force)
                        ▼
                ┌──────────────┐
                │  spec'ing    │ (agent asking + drafting)
                └────┬─────┬───┘
                     │     │
       approve & run │     │ abandon
                     ▼     ▼
            ┌──────────┐  ┌────────────┐
            │ running  │  │ abandoned  │ (terminal)
            └────┬─────┘  └────────────┘
                 │
        success  │  failure
                 ▼  ▼
        ┌──────────┐ ┌──────────┐
        │ reviewed │ │ reviewed │ (failure also lands here)
        └────┬─────┘ └────┬─────┘
             │            │
             │            └─► user can retry (→ running) or abandon (→ abandoned)
             ▼
        ┌──────────┐
        │ merged   │ (terminal)
        └──────────┘

Off-mode shortcut:
   draft → running → reviewed → merged
```

## Appendix B: SSE event timeline (spec mode)

```
t0  user POST /v1/prompt { prompt, specMode: "auto" }
t1  spec_status: spec'ing
t2  spec_question: [{ id: q1, prompt: "What roles?", kind: "text" }, ...]
t3  user PATCH /v1/threads/:id/spec { answers: { q1: "admin, editor, viewer", ... } }
t4  spec_draft: { goal: "...", files: [...], plan: [...], risks: [...] }
t5  user POST /v1/threads/:id/approve
t6  spec_status: running
t7  message: "reading workspace..."
t8  message: "drafting plan..."
t9  diff: { files: [{ path: "...", patch: "..." }] }
t10 spec_status: reviewed
```
