# Aelvyril Cloud Platform — Design Spec

> **Date:** 2026-05-05
> **Status:** Approved
> **Branch:** `archive/desktop` (old desktop app archived, new cloud platform TBD)

## 1. Product Overview

### What it is

A cloud-based coding agent platform where pi (with PiMemoryExtension and PiArgus) runs on the host machine with git-branch isolation per task. Users connect their repos, bring their own LLM API keys, and get an AI coding agent that remembers everything across sessions and can dispatch parallel sub-agents through a managed pipeline.

### What makes it different

- **Persistent memory** — PiMemoryExtension means the agent gets smarter over time. Kilo, Devin, etc. have no cross-session memory. Your agent builds institutional knowledge about every codebase.
- **7-agent autonomous pipeline** — specialized agents for planning, execution, testing, review, and supervision
- **Kanban-driven coordination** — agents communicate through a shared board, not direct messaging. Fully observable.
- **Watchdog supervisor** — active monitoring that detects stalls and unblocks, solving the "things get stuck" problem
- **Git-branch isolation** — each sub-agent works on its own branch, no file conflicts between parallel tasks
- **BYOK** — users bring their own API keys, the platform doesn't pay for model inference
- **Self-hostable** — SaaS + open-source self-hosted edition
- **Local-first** — v1 runs entirely on localhost. Cloud is a config swap, not a rewrite.

### User flow

1. Sign up / configure locally
2. Add LLM API key(s) (OpenAI, Anthropic, etc.) via settings UI
3. Pick a repo → Aelvyril clones it into a local workspace
4. Chat with the Supervisor via the web UI chat panel (or `aelvyril chat` CLI) to make requests
5. Supervisor routes to Ticket Agent → board → execution pipeline
6. Watchdog monitors progress, unblocks stalls
7. User observes everything via web UI (read-only dashboard)
8. Changes auto-commit per ticket, merge into session branch on approval
9. Create PRs from within the platform

---

## 2. Architecture

### 2.1 Local-first, cloud-later principle

The entire system is built around interfaces that have both local and cloud implementations:

| Interface | Local (v1) | Cloud (future) |
|---|---|---|
| Execution Backend | Git branches on host | Container/smolvm fleet manager |
| User Storage | SQLite (local filesystem) | PostgreSQL |
| Workspace Files | Local filesystem | Object storage (S3/R2) |
| Memory DB | SQLite (PiMemoryExtension) | PostgreSQL or managed SQLite |
| Auth | None (single local user) | OAuth + API keys |

### 2.2 System diagram

```
┌─────────────────────────────────────────────────────────┐
│                    USER INTERFACE                        │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────────┐  │
│  │ CLI      │  │ Web UI   │  │ Observability         │  │
│  │ (chat    │  │ (board + │  │ Dashboard             │  │
│  │  with    │  │ settings)│  │ (read-only agent      │  │
│  │  Super-  │  │          │  │  activity)            │  │
│  │  visor)  │  │          │  │                       │  │
│  └────┬─────┘  └────┬─────┘  └─────┬─────────────────┘  │
│       │              │              │                    │
│       └──────────────┴──────────────┘                    │
│                      │ HTTP + WebSocket                  │
├──────────────────────┼──────────────────────────────────┤
│              Orchestrator (Node.js)                       │
│  ┌──────────┐ ┌──────┴──────┐ ┌───────────────────┐    │
│  │ Session  │ │   Agent     │ │  Workspace        │    │
│  │ Manager  │ │   Pool      │ │  Manager          │    │
│  └──────────┘ └─────────────┘ └───────────────────┘    │
│       │              │                │                  │
│  ┌────┴──────────────┴────────────────┴───────────────┐  │
│  │        Execution Backend (interface)                │  │
│  │  ┌─────────────┐    ┌──────────────────────────┐   │  │
│  │  │  LOCAL:      │    │  CLOUD:                   │   │  │
│  │  │  git branches│    │  container/smolvm fleet  │   │  │
│  │  │  on host     │    │  manager                  │   │  │
│  │  └─────────────┘    └──────────────────────────┘   │  │
│  └────────────────────────────────────────────────────┘  │
│                                                           │
│  ┌────────────────────────────────────────────────────┐  │
│  │         7-Agent Pipeline (see §3)                   │  │
│  │  Supervisor → Ticket → Main → Sub-agents →         │  │
│  │  Test → Review + Watchdog (continuous)              │  │
│  └────────────────────────────────────────────────────┘  │
│                                                           │
│  ┌────────────────────────────────────────────────────┐  │
│  │       PiMemoryExtension + PiArgus (shared)          │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 2.3 Core services

| Service | Responsibility |
|---|---|
| **Orchestrator** | Main Node.js server. HTTP + WebSocket. Manages sessions, routes API calls, spawns and manages all pi agent processes. |
| **Session Manager** | Create/destroy/list/pause/resume coding sessions. Each session = one workspace + one Kanban board + one set of long-running agents. |
| **Agent Pool** | Manages all pi processes. Spawns/kills agents. Routes JSON-RPC messages between them. Handles long-running vs ephemeral lifecycles. |
| **Workspace Manager** | Manages filesystem workspaces. Local: direct filesystem access. Cloud: virtual filesystem backed by object storage. Same interface. |
| **Execution Backend** | Manages sub-agent workspace isolation. Local: git branches on host filesystem. Cloud: container/smolvm fleet. Same interface. |

### 2.4 Communication

All agent-to-agent communication is **JSON-RPC over stdin/stdout** — the same way pi works today.

- **Orchestrator → Agent**: spawns pi process, sends/receives JSON-RPC via stdin/stdout
- **Web UI / CLI → Orchestrator**: HTTP REST + WebSocket
- **Agent → Agent**: mediated by Orchestrator (it is the message bus)
- **No Redis, no message queue** — the Orchestrator routes messages between agents directly

### 2.5 Agent process lifecycles

**Long-running agents (run directly on host, no sandbox):**
These are system agents — they manage the pipeline, not user code. They run as pi processes on the host machine.

| Agent | Lifecycle | When created | When killed |
|---|---|---|---|
| Supervisor | Long-running | Session start | Session end |
| Watchdog | Long-running | Session start | Session end |
| Main Agent | Long-running | Session start | Session end |

**Ephemeral agents:**

| Agent | Lifecycle | When created | When killed |
|---|---|---|---|
| Ticket Agent | Ephemeral | Supervisor receives user request | After populating board |
| Sub-agents | Ephemeral | Main Agent dispatches ticket | After completing ticket |
| Test Agent | Ephemeral | Sub-agent completes ticket | After test run |
| Review Agent | Ephemeral | Test Agent passes | After review decision |

**Agent isolation is via git branches**, not VMs. Each sub-agent works on its own `aelvyril/ticket-{id}` branch. No two sub-agents share a branch. The Ticket Agent's concurrency plan ensures no two active sub-agents touch the same file.

### 2.6 State persistence & crash recovery

The system is designed to survive sudden termination — app crash, power loss, `kill -9`, anything.

**Principle: every meaningful action is persisted immediately, not batched.**

| State | Storage | Write timing | Survives power loss? |
|---|---|---|---|
| Kanban board (tickets + concurrency plan) | SQLite (WAL mode) | Every ticket state change is a synchronous write | ✅ Yes |
| PiMemoryExtension DB | SQLite (WAL mode) | Every agent turn saves to memory — decisions, discoveries, bugfixes, patterns | ✅ Yes |
| Agent process state | Not stored — ephemeral | N/A | ❌ Lost (but board + memory capture what matters) |
| Audit log | SQLite (WAL mode) | Every agent action logged immediately | ✅ Yes |
| Cost tracking | SQLite (WAL mode) | Updated after every LLM call | ✅ Yes |
| Git commits | Git object store | Sub-agents commit after each meaningful change | ✅ Yes |
| User config | `~/.aelvyril/config.json` + SQLite | Written on save | ✅ Yes |

**Recovery flow after crash/power loss:**

1. Orchestrator starts → reads session DB → finds active sessions
2. Session Manager loads Kanban board from SQLite → sees ticket states
3. Watchdog starts → scans for stale states:
   - `In Progress` tickets → re-dispatch to new sub-agent (previous sub-agent process is dead). The git branch is preserved — the new sub-agent picks up where the old one left off.
   - `Testing` tickets → re-spawn Test Agent (tests run against existing ticket branch)
   - `In Review` tickets → re-spawn Review Agent
4. All agents resume context from PiMemoryExtension — they remember what they were doing
5. Long-running agents (Supervisor, Main Agent, Watchdog) restart fresh but load session context from memory
6. User sees the board as it was before the crash, with a "recovered from crash" notification

**Key guarantee:** No ticket ever disappears. If it was in the pipeline, the Watchdog will pick it up and either re-dispatch or escalate. PiMemory ensures agents don't lose institutional knowledge even across crashes.

### 2.7 Agent health checks

The Orchestrator monitors agent health via **JSON-RPC healthcheck**:

- Every agent exposes a `healthcheck` JSON-RPC method
- Orchestrator sends `healthcheck` request every 10s to long-running agents
- If no response within 5s → agent is considered unresponsive
- If process exit is detected → agent is considered crashed
- On unresponsive/crashed:
  - Long-running agents → Orchestrator restarts them, they load context from PiMemory
  - Ephemeral agents → Watchdog handles re-dispatch of their ticket

### 2.8 Host requirements (v1)

Since all agents run directly on the host:

**Required on host:**
- Node.js ≥ 22.5 (pi requirement)
- git, gh CLI
- pi (installed globally)
- PiMemoryExtension (installed as pi extension)
- PiArgus (installed as pi extension)

**Optional on host:**
- Obscura (for PiArgus light tier browser automation)
- Python 3, Go, Rust, etc. (as needed by the project being worked on)
- Build tools (gcc, make, cmake) as needed

**Cloud future:** When cloud launches, sub-agents may run in containers or sandboxes for multi-tenant isolation. The Execution Backend interface abstracts this — local uses direct git branches, cloud uses sandboxed environments.

---

## 3. Agent Topology

### 3.1 Seven agents, one shared memory

```
User → Chat (web/CLI) → Supervisor
                 ├── New request → Ticket Agent → board → ...
                 ├── Redirect → Watchdog → Main Agent
                 ├── Status check → reads board state → responds
                 ├── Cancel → Watchdog → kills all sub-agents
                 └── Settings → updates config

Ticket Agent → Kanban Board (5 columns)
  Backlog → In Progress → Testing → In Review → Done
                │              │          │
                ▼              │          ▼
           Main Agent    fail→In Progress  Review Agent
                │              │          │
          ┌─────┼─────┐        │     approve→Done
          ▼     ▼     ▼        │     reject→Backlog
       Sub    Sub    Sub       │
       (one ticket each, own git branch)
                         Test Agent picks up here

Watchdog ── polls board every 5s, uses LLM only when stuck 5+ min
```

### 3.2 Agent roles

| # | Agent | Role | LLM needed? | Key responsibility |
|---|---|---|---|---|
| 1 | **Supervisor** | User interface | Yes | Only agent the user talks to. Receives requests, routes to Ticket Agent. Handles mid-execution redirects. Reports status. |
| 2 | **Ticket Agent** | Planner | Yes | Breaks request into tickets. Decides concurrency — how many parallel agents, which can run together, no two agents touch the same file. |
| 3 | **Main Agent** | Executor | Yes | Picks tickets off board, dispatches sub-agents. Respects Ticket Agent's concurrency rules. |
| 4 | **Sub-agents** | Workers | Yes | Ephemeral. One ticket each. Own git branch. |
| 5 | **Test Agent** | Tester | Yes | Writes test cases for ticket acceptance criteria AND runs the full test suite. After sub-agent completes, before Review Agent. |
| 6 | **Review Agent** | Reviewer | Yes | Code review after tests pass. Approves or rejects with feedback. |
| 7 | **Watchdog** | Monitor | Conditional | Heartbeat polls board every 5s (no LLM). Uses LLM only when intervening — re-scoping, deadlock resolution. Skips AI check if ticket has recent activity. Only invokes LLM if 5+ min passed with no state change. |

### 3.3 User interaction model

**All user input flows through the Supervisor.** The user cannot talk directly to any other agent or bypass the pipeline.

**User can:**
- Chat with the Supervisor via the web UI chat panel or `aelvyril chat` CLI command (both connect via WebSocket to the same Supervisor)
- See what every agent is doing (read-only observability dashboard)
- Choose which LLM models each agent type uses
- Configure settings via web UI (API keys, model selection, concurrency limits, watchdog thresholds)

**User cannot:**
- Talk directly to any agent except Supervisor
- Bypass the ticket pipeline
- View or edit code in the platform (check changes on your local machine, GitHub, or your own IDE — full agentic)

### 3.4 User interface

The user interface has two modes:

1. **Web UI** — served by the Orchestrator at `localhost:PORT`. Contains:
   - Chat panel (left sidebar) — talks to Supervisor via WebSocket
   - Kanban board — live ticket status (read-only)
   - Agent activity feed — real-time feed of what each agent is doing (read-only)
   - Cost dashboard — token usage and cost per agent/ticket/session (read-only)
   - Settings page — API keys, model selection, concurrency, watchdog thresholds (editable)

2. **`aelvyril chat` CLI** — a readline loop that connects via WebSocket to the Orchestrator. For terminal-heavy users who don't want a browser. Same Supervisor, same chat.

No code viewer, no file tree, no in-browser editor. Users check code on their own machine, GitHub, or their own IDE.

### 3.5 Kanban board

**Columns (5):** Backlog → In Progress → Testing → In Review → Done

```
Backlog → In Progress → Testing → In Review → Done
              ↑              │          │
              │     fail     │   reject │
              └──────────────┘          │
              ◄─────────────────────────┘
              ◄── held (any state, on API failure)
```

- Sub-agent completes work → moves to **Testing**
- Test Agent writes test cases, runs them:
  - **Pass** → moves to **In Review** (Review Agent picks up)
  - **Fail** → moves back to **In Progress** (same or new sub-agent, with test failure context from Test Agent)
- Review Agent:
  - **Approve** → moves to **Done**
  - **Reject** → moves back to **Backlog** (with review notes)

**Ticket schema:**
```typescript
interface Ticket {
  id: string;                    // "#1", "#2", etc.
  title: string;
  description: string;           // Full context
  acceptance_criteria: string[]; // How to know it's done
  dependencies: string[];        // Ticket IDs that must complete first
  files: string[];               // Files this ticket will touch
  priority: number;
  status: 'backlog' | 'in_progress' | 'testing' | 'in_review' | 'done' | 'held';
  assigned_agent: string | null; // Sub-agent ID when in_progress
  test_results: TestResult | null;   // Test Agent output
  review_notes: string | null;      // Review Agent feedback on reject
  reject_count: number;             // How many times rejected (cumulative)
  held_reason: string | null;       // Why ticket is held (e.g. "LLM API rate limit", "provider down")
  git_branch: string | null;        // Ticket branch name
  cost_tokens: number;              // Cumulative tokens across all attempts
  cost_usd: number;                 // Cumulative cost across all attempts
  created_at: string;               // ISO 8601
  updated_at: string;               // ISO 8601
}
```

### 3.6 Concurrency control

The Ticket Agent produces a concurrency plan that is **stored as part of the board state** — not just emitted once. The Main Agent reads it to know which wave to execute. The Watchdog reads it to understand expected parallelism. If re-planning is needed (after reject or redirect), the Ticket Agent updates the plan in place.

```typescript
interface ConcurrencyPlan {
  tickets: Ticket[];
  max_parallel: number;              // Never more than N agents at once
  waves: string[][];                 // Wave 1: [#1, #4], Wave 2: [#2], etc.
  conflict_groups: string[][];       // Tickets that cannot run together
}
```

The board state includes both tickets and the plan:
```typescript
interface BoardState {
  session_id: string;
  tickets: Ticket[];
  plan: ConcurrencyPlan;
  created_at: string;
  updated_at: string;
}
```

**Rule: no two active sub-agents touch the same file.** The Ticket Agent enforces this in the plan.

### 3.7 Git strategy

| Event | Git action |
|---|---|
| Session starts | Clone repo, create `aelvyril/session-{id}` branch from main |
| Sub-agent starts ticket | Create `aelvyril/ticket-{id}` from session branch |
| Sub-agent completes work | Auto-commit: `ticket({id}): {title}` |
| Test Agent writes tests | Auto-commit: `test({id}): add test cases for {title}` |
| Test Agent fails | No git action — ticket goes back to In Progress |
| Review Agent approves | Merge ticket branch into session branch |
| Review Agent rejects | Reset ticket branch, leave review notes on board |
| All tickets done + all reviews pass | **Main Agent** auto-creates PR from session branch to main |
| PR checks pass | **Main Agent** auto-merges PR |

---

## 4. Watchdog Agent (Stuck Detection)

### 4.1 Purpose

The Watchdog is the **immune system** of the pipeline. It doesn't do creative work — it keeps things flowing. This directly solves the Kilo Cloud Agents problem where tasks silently stall.

### 4.2 Heartbeat mechanism

The Watchdog polls the board **every 5 seconds** with a simple rule:

1. **Check each ticket's state and `updated_at`**
2. If a ticket has **recent activity** (state changed or agent output in last 5 min) → **skip, do nothing**
3. If a ticket has **no activity for 5+ minutes** and state hasn't changed → **invoke LLM to analyze and intervene**
4. LLM decides: re-scope, retry, break deadlock, escalate to user

This means the Watchdog uses zero LLM tokens during normal healthy operation. It only burns tokens when something is actually stuck.

### 4.3 Detection rules (when LLM is invoked)

| Condition | Action |
|---|---|
| Ticket in Backlog > 5 min with no blockers | Move to In Progress, nudge Main Agent |
| Ticket in In Progress > 10 min | Check sub-agent status — crashed → retry; running → wait 5 more min; still running after 15 min → kill + re-scope |
| Ticket in Testing > 10 min | Check Test Agent alive — if not, re-spawn; if alive but stuck, kill + re-dispatch to In Progress |
| Ticket in In Review > 5 min | Check Review Agent alive — if not, re-assign; if alive, wait |
| Ticket rejected 3 times | Auto-escalate to user with summary of all 3 attempts |
| Ticket rejected 5 times | Hard stop — ask user for guidance, stop burning credits |
| Sub-agent process crashed | Auto-retry once (new pi process, same ticket branch). Log failure to memory. |
| Deadlock (circular deps) | Break cycle — identify weakest dependency, split or remove |
| All tickets Done | Notify user, summarize accomplishments |
| Session restart with stale In Progress tickets | Re-dispatch all stale tickets |
| LLM API failure (rate limit, provider down, auth error) | Move active ticket to **Held** state. Notify user via chat with error details. Pause all other tickets for that agent type. User must resolve (fix API key, wait for rate limit, switch provider) before tickets resume. |
| User resolves held issue | Watchdog detects resolution → moves tickets back to their previous state, resumes pipeline |

### 4.4 Progress reporting

Watchdog sends real-time status to the UI:

```json
{
  "session_id": "abc123",
  "total_tickets": 7,
  "status": {
    "done": 3,
    "in_review": 1,
    "testing": 1,
    "in_progress": 1,
    "backlog": 1
  },
  "alerts": [
    { "ticket": "#12", "type": "stuck", "message": "In Progress for 12min — re-scoping" },
    { "ticket": "#9", "type": "retry", "message": "Sub-agent crashed — retrying" }
  ]
}
```

---

## 5. Memory Layer

### 5.1 Shared PiMemoryExtension

All agents in a session share one PiMemoryExtension database. This is the core differentiator.

- **Supervisor** — reads context, saves session decisions
- **Ticket Agent** — reads codebase knowledge to plan tickets accurately
- **Main Agent** — reads execution history to make dispatch decisions
- **Sub-agents** — reads relevant context for their ticket, saves discoveries
- **Test Agent** — reads test patterns and known issues
- **Review Agent** — reads codebase conventions and past review findings
- **Watchdog** — reads/writes failure patterns and stall history. Uses LLM only for intervention decisions (re-scoping, deadlock resolution), not for routine heartbeat checks.

### 5.2 Memory write conflicts

PiMemoryExtension uses SQLite WAL mode — concurrent writes don't corrupt data.

**Handled by PiMemory already:**
- Dedup (85% auto-merge, 60-84% warning)
- Trust scoring (changed code loses trust)

**Mitigation for v1:**
- Concurrency plan prevents sub-agents from touching the same files
- Contradictory memories are rare when file conflicts don't exist
- Trust scoring naturally decays less-useful observations over time

**Future enhancement:**
- Add a memory reconciliation pass in Main Agent after each wave completes
- Review recent memories from sub-agents and flag contradictions

### 5.3 Per-session isolation

- Each session has its own Kanban board
- All agents in a session share **one PiMemoryExtension DB** — that's how PiMemory works (single SQLite DB). Every agent (Supervisor, Ticket, Main, Sub-agents, Test, Review, Watchdog) reads and writes to the same memory database for that session.
- Sessions are fully isolated — each session gets its own memory DB file. Agents in session A can't see session B.
- User can have multiple sessions, Supervisor context-switches one at a time
- Optional: share a cross-session knowledge base for the same repo

---

## 6. Cost Tracking

Every agent action is metered (BYOK — user's own API keys):

```typescript
interface CostReport {
  session_id: string;
  total_tokens: number;
  total_cost_usd: number;
  by_agent: {
    supervisor: { tokens: number; cost: number };
    ticket_agent: { tokens: number; cost: number };
    main_agent: { tokens: number; cost: number };
    sub_agents: { tokens: number; cost: number };
    test_agent: { tokens: number; cost: number };
    review_agent: { tokens: number; cost: number };
    watchdog: { tokens: number; cost: number }; // 0 during normal polling, non-zero when intervening
  };
  by_ticket: Record<string, { tokens: number; cost: number }>;
}
```

Watchdog factors cost into escalation decisions ("this ticket has burned $2 in retries — escalate to user").

---

## 7. Observability & Audit Trail

### 7.1 Live audit log

Every action is logged with timestamp, agent, and ticket context:

```
[14:23:01] SUPERVISOR: Received request "Add dark mode"
[14:23:02] TICKET_AGENT: Created 4 tickets, concurrency plan: max 2 parallel
[14:23:03] MAIN_AGENT: Dispatched #1 (Add theme context) → sub-agent-a
[14:23:03] MAIN_AGENT: Dispatched #4 (API refactor) → sub-agent-b
[14:24:15] sub-agent-a: Completed #1, committed 3 files
[14:24:16] TEST_AGENT: Running tests for #1... 47 passed
[14:24:18] REVIEW_AGENT: Reviewing #1... ✅ Approved
[14:24:19] WATCHDOG: #1 done, #2 now unblocked → notifying Main Agent
[14:30:00] WATCHDOG: ⚠ #4 in progress for 7min, still running — no action
[14:35:02] sub-agent-b: Completed #4, committed 2 files
```

### 7.2 Web UI views

- **Kanban board** — live ticket status, drag-to-reorder (future)
- **Agent activity** — real-time feed of what each agent is doing
- **Cost dashboard** — token usage and cost per agent, per ticket, per session
- **Audit trail** — full log of all actions

### 7.3 Model selection

Users can choose which LLM model each agent type uses via settings UI. For example:
- Supervisor: Claude Sonnet (fast, cheap)
- Ticket Agent: Claude Sonnet
- Sub-agents: Claude Opus (powerful, expensive)
- Review Agent: Claude Sonnet
- Watchdog: No LLM for routine polling, LLM invoked only for intervention decisions

---

## 8. Config & Settings

### 8.1 Settings UI (web frontend)

Users configure via a settings page in the web UI:
- API keys (encrypted at rest)
- Model selection per agent type
- Max parallel agents
- Watchdog timeout thresholds
- Git settings (branch prefix, auto-commit messages)
- Workspace preferences

### 8.2 Config file (optional, for local/CLI)

`~/.aelvyril/config.json` — overrides defaults for local-only use.

---

## 9. Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | React + TypeScript + Vite+ | SPA, ported selectively from desktop v0.1 |
| Backend | Node.js + TypeScript | Orchestrator, HTTP + WebSocket server |
| Agent runtime | pi | Spawned as child processes, JSON-RPC over stdio |
| Memory | PiMemoryExtension | SQLite, one DB per session |
| Browser/search | PiArgus | Obscura (light) + Chromium (heavy) |
| Sandboxing | None (v1 — git branch isolation) | smolvm/containers (cloud) |
| Database | SQLite (v1) | Postgres (cloud) |
| Dev toolchain | Vite+ (`vp`) | Build, lint, format, test — one CLI |

### 9.1 Frontend components (ported from desktop v0.1)

| Component | Action |
|---|---|
| CommandPalette | Port directly — fuzzy search for commands/actions |
| DepGraph | Port — visualize ticket dependency graph and concurrency waves |
| ActivityRow | Port — show live agent status across all 7 agents |
| Workspace | Port — split-pane layout (chat panel + kanban + activity feed) |
| OutputScroll | Port — agent output streaming / audit trail |
| TitleBar | **Drop** — no custom window chrome on web |
| FileTree | **Drop** — no file browsing in the platform |
| CodeViewer | **Drop** — no code viewing in the platform |
| CSS (terminal aesthetic) | Port directly — JetBrains Mono, dark theme |

---

## 10. Deployment Model

### 10.1 v1: Local-only

- Everything runs on localhost
- No auth — single local user
- No cloud dependencies
- SQLite for all storage
- All agents run on host (no VM/container layer)

### 10.2 v2: Cloud SaaS

- Deploy to cloud infrastructure (TBD — likely VPS or container service)
- Add auth (OAuth)
- Postgres for user/session storage
- Remote container/smolvm fleet management
- Stripe billing (optional)

### 10.3 v2: Self-hosted

- Open-source edition
- Docker Compose or bare-metal deployment
- Same features as SaaS, user manages their own infra
- Documentation for self-hosting

---

## 11. Deferred Items (TODO Later)

These are acknowledged but explicitly out of scope for v1. They should be revisited during cloud migration planning.

| # | Item | Priority | Notes |
|---|---|---|---|
| 1 | **Web UI detailed design** | Medium | Kanban board component design, observability dashboard layout, responsive design |
| 2 | **Authentication & multi-user** | High (cloud) | OAuth, team accounts, org-level settings. Not needed for local v1. |
| 3 | **CI/CD integration** | Medium | Webhooks to trigger sessions, auto-merge PRs, branch protection integration |
| 4 | **Rate limiting / abuse prevention** | High (cloud) | Per-user rate limits, concurrent session limits, cost caps |
| 5 | **Plugin / extension system** | Low | Allow third-party agent types, custom board columns, user-defined tools |
| 6 | **Mobile / cross-device access** | Low | View sessions from phone, read-only mobile dashboard |
| 7 | **Collaboration** | Medium | Share sessions, multi-user kanban, team reviews |
| 8 | **Memory reconciliation** | Medium | Post-wave memory conflict resolution in Main Agent |
| 9 | **Advanced git workflows** | Low | Rebase vs merge strategies, custom PR templates, branch protection |
| 10 | **Performance monitoring** | Medium | Agent latency metrics, LLM response time, branch merge time |
