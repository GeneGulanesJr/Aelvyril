# ADR-0006: Risk-class autonomy, agent-driven spec, auto-verify

Date: 2026-10-05
Status: Accepted
Supersedes (in part): the per-plan approval + keyword spec heuristic of the
[agent spec-centric UI redesign](../superpowers/specs/2026-09-23-agent-spec-centric-ui-redesign.md)
(decisions D2/D9)
Implements: issues #80 (wire the spec→approve→execute loop), #81 (gate per
risk class), #82 (auto-verify loop)

## Context

Issue #80 (blocking) verified the product's core promise was unreachable:
`AgentContract` was never instantiated, `specMode` was parsed then dropped,
approve/retry flipped SQLite rows against an always-empty contracts map, and
nothing produced the `diff` or `merged` states. Two architectural findings
came with it:

- Per-plan approval reintroduces micromanagement at scale (#81): decision
  load grows linearly with asks, and a keyword heuristic measures syntax,
  not ambiguity — "add x to y" interrogates while "fix the login bug"
  (vaguer, riskier) sails through.
- Failure landed in `reviewed` and waited for a human retry — the user was
  the CI system (#82).

## Decision

**1. The loop is wired through the supervisor (#80).** One `AgentContract`
per session host is constructed in `Supervisor.ensureSession`; the contract
translates protocol events into store-grammar envelopes and owns the
turn lifecycle. `specMode` rides from the route through
`Supervisor.prompt`. Approve/retry rebuild the execution prompt from the
PERSISTED spec (`conversations.spec_draft`), so they work with no live host
(gateway restart between spec'ing and approve). On `agent_settled` with
edits the gateway — which owns the spawn cwd — computes the workspace `git
diff` itself and emits the `diff` envelope; the reviewed transition follows.
`POST /v1/threads/:id/merge` is the `merged` producer.

**2. Gate per risk class, not per plan (#81).** Every live tool call and
every spec-draft plan passes a pure risk classifier (`risk.ts`) with three
classes:

- **reversible** — workspace-scoped reads/edits: always auto-run; the user
  reviews post-hoc via the diff (`reviewed` → `merged`).
- **external** — installs, migrations, outbound fetches: gated while a
  namespace is new, auto-run once trust is established.
- **irreversible** — recursive deletes, remote pushes, schema drops,
  sandbox promotes, deploys: always gated.

Every classification is published as the `laya_verdict` envelope — its
first real producer. A gated action stops the run (`abort`), marks the
thread blocked with reason `gated`, and records the action; `POST /approve`
allows exactly that action class and resumes. Trust escalation (#81.3): a
namespace's merged-without-revision count (tracked in SQLite; a merge right
after `reviewed` with no intervening retry) raises autonomy to
"established" at `GATEWAY_TRUST_THRESHOLD` (default 5).

**3. The agent owns the spec trigger (#81.2).** Prompts carry the spec
protocol as instructions: ask 2–5 questions via a `custom_spec_question`
signal when — and only when — the request is genuinely ambiguous, draft via
`custom_spec_draft`, then end the turn; the gateway starts execution. The
legacy keyword regex is demoted to a dead-man switch: it no longer forces
an interview, it only strengthens the instruction on pattern-matched asks.
`specMode: "off" | "force"` remain hard user overrides, and the interview
is bounded (`GATEWAY_SPEC_MAX_ROUNDS`, default 3) — past the budget the
agent is told to proceed on best judgment.

**4. The gateway is the CI system (#82).** After an execution settles with
edits, the gateway runs the workspace's verify commands (auto-detected
`test`/`lint`/`typecheck` scripts, or `GATEWAY_VERIFY_COMMANDS`), stops at
the first failure, and feeds the bounded output back to the agent as a new
prompt. Self-retries are capped (`GATEWAY_VERIFY_RETRIES`, default 3);
only exhaustion escalates to the user, with the failure output attached to
the error envelope. The gated class waits for approve before executing;
both classes get the same post-execution verification.

## Consequences

- The core promise (spec interview → plan + diff → approve → execute) is
  testable end to end; the fixture scripts every agent-side signal
  (`FAKE_SPEC_QUESTIONS`, `FAKE_PLAN_JSON`, `FAKE_GATED_TOOL`,
  `FAKE_EDIT_FILE`) and the route tests drive real git repos.
- Approve stops meaning "I saw your plan" and starts meaning "I allow this
  execution" — including mid-run, per action class.
- Casual asks gain a real terminal path: edits → auto-verify → reviewed →
  merged, with no spec friction.
- The heuristic stays in the codebase but is no longer load-bearing; if the
  model under-asks, the dead-man switch and the question budget are the
  guardrails.
- New env knobs: `GATEWAY_VERIFY` (0 disables), `GATEWAY_VERIFY_COMMANDS`,
  `GATEWAY_VERIFY_RETRIES`, `GATEWAY_VERIFY_TIMEOUT_MS`,
  `GATEWAY_TRUST_THRESHOLD`, `GATEWAY_SPEC_MAX_ROUNDS`.
