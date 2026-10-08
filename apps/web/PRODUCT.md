# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary user: a GulanesKorp developer (today literally one developer; the platform is multi-user capable via Clerk) who delegates coding work to a supervised agent from a browser. Their situation: they type an ask in plain language, walk away while the agent works, and come back to review an artifact. Their job: turn intent into a reviewed, merged diff with the least decision load possible. (All facts in this record are derived from repository docs — README.md, docs/superpowers/specs/, docs/adr/ — at the user's delegation to "figure it out from the codebase and docs," not from a live interview.)

## Product Purpose

Aelvyril is an agent workspace: you describe work in plain language, and a supervised coding agent (Pi) either just does it or — when the ask is genuinely ambiguous — runs a short spec interview before touching anything. Every thread ends in the same artifact regardless of how casual the ask was: a plan, an execution trace, and a diff you review and merge. The gateway acts as the CI system (auto-verify with retry, risk-class autonomy, cost caps, durable queueing) so the user approves decisions, not individual tool calls. Success means: an ask costs one sentence, a review costs one screen, and the user can walk away mid-run.

## Positioning

"The artifact is always plan + diff — never just a transcript." A neighboring chat product cannot truthfully copy: agent-drafted, user-editable specs (the user never writes a spec from scratch); risk-class autonomy where reversible work auto-runs and only irreversible/external actions stop for a per-action approve; and durable queueing (prompts run unattended; the browser is not required).

## Operating Context

Runs as a local/self-hosted Docker stack (web :3000, gateway :8787 behind Caddy same-origin `/v1`, sandd sandbox, DecisionMCP) used over loopback by the developer. Auth is Clerk (JWT bearer on every gateway call; SSE must use fetch + ReadableStream, never EventSource). The unit of work is a **thread** with status lifecycle `draft → spec'ing → running → reviewed → merged` plus `abandoned`, `queued`, and runtime states `degraded` and `blocked` (reasons: `question`, `dialog`, `capped`, `gated`). All updates arrive as SSE event envelopes; threads persist forever, status-tagged, and are resumable.

## Capabilities and Constraints

- Thread routes: create/list/get/patch(rename)/delete, `prompt` (`specMode: auto|force|off`, steer-queued sends while running), `approve`, `abandon`, `retry`, `merge`, `abort`, `kill-all`, spec PATCH (answers + field edits), SSE `events` with `Last-Event-ID` replay.
- Envelope kinds the UI may receive: `text_delta`, `tool_call`, `tool_result`, `subagent_spawn`, `sandbox_exec`, `sandbox_promote`, `laya_verdict`, `user_message`, `session_state`, `error`, `spec_question`, `spec_draft`, `spec_status`, `diff`, `usage`, `dialog`, `custom`.
- Error contracts the UI must render: 429 `rate_limited` (Retry-After), 503 `conversation_limit_reached`, 202 `{queued:true}` / 409 `already_queued`, 403 `cost_cap_reached`, 429 `too_many_streams`, 413 `spec_too_large`, 400 `workspace_not_allowed`.
- Diffs render as plain unified-diff text with line highlighting — no Monaco, no in-browser code editing (documented non-goal, keep).
- Admin self-update endpoints exist but are not part of the ordinary UI surface.
- Terminology is binding: "thread" (never "conversation" in UI), "spec interview / spec draft / answers", "Ask" and "Ask + spec", "approve & run / abandon / retry / merge", "degraded", "Needs you" (blocked), "kill-all", "workspace".

## Brand Commitments

Name: **Aelvyril** (GulanesKorp). The incumbent visual contract (spec §5.3 GitHub-dark hex palette: `#0d1117`/`#2b3245`/`#1f6feb`/`#3fb950`/`#e3b341`/`#f85149`) governed the *previous* surface; the current request is a redesign, so it is recorded as evidence of what the subject is, not as a binding constraint. Dark-first usage (a developer tool used in a terminal-adjacent context) is factual operating context.

## Evidence on Hand

Repository docs: README.md (stack), docs/superpowers/specs/2026-09-22-aelvyril-agent-platform-design.md (platform), docs/superpowers/specs/2026-09-23-agent-spec-centric-ui-redesign.md (superseded surface spec), docs/adr/0001–0006 (autonomy, queueing, namespaces), docs/ops/*.md, docs/design/stack-topology.html (superseded diagram, GitHub-dark styling). No marketing assets, no screenshots, no testimonials, no logo files (public/ is empty except .gitkeep). Future work must not fabricate customers, benchmarks, or pricing — none exist.

## Product Principles

1. **The artifact is always plan + diff** — never just a transcript; every thread resolves to reviewable work.
2. **Casual asks stay light** — no spec friction unless the ask is genuinely ambiguous; the agent decides when to interrogate, the user can force or skip.
3. **Approve means "I allow this execution"** — decision load must not grow linearly with asks; "Needs you" is reserved for gated/irreversible/capped situations, and per-plan approval re-introducing micromanagement is the named failure mode.
4. **Threads are durable artifacts** — persist forever, status-tagged, resumable; the unit is work, not a chat conversation.
5. **Agent drafts, user edits** — the user never writes a spec from scratch; verification and retries are the gateway's job, surfaced honestly (degraded/blocked are states, not errors to hide).
