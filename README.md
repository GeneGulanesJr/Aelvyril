# Aelvyril

Chat-first frontend for the GulanesKorp agent platform (pi + PiSubagent + LaPis + PiSandboxed + LayaMCP, all in Docker).
Spec: `docs/superpowers/specs/2026-09-22-aelvyril-agent-platform-design.md` · ADRs: `docs/adr/`

## Dev

Requires Node 22+ and pnpm 10. Real Clerk dev keys go in `apps/web/.env.local` + `apps/gateway/.env`. The `apps/gateway/.env.example` file is the template (untracked locally).

    # terminal 1 — gateway (auto-loads apps/gateway/.env; spawns real pi session hosts)
    pnpm --filter @aelvyril/gateway start
    # terminal 2 — web
    pnpm --filter @aelvyril/web dev

Open <http://localhost:3000>. If port 3000 is held by something on your host, run `pnpm exec next dev --webpack -p 3001` instead and update `GATEWAY_ALLOWED_ORIGIN` in `apps/gateway/.env` to match.

To fall back to the scripted fake `pi` child (no real LLM calls), set `PI_FAKE=1` in `apps/gateway/.env`.

## Checks

    pnpm -r typecheck && pnpm -r lint && pnpm -r test

> Windows note: this repo is developed under PowerShell — run the check commands one at a time (or use `;`).

## Clerk setup

Phase 2 ships with the gateway enforcing Clerk JWT bearer auth (`@clerk/backend.verifyToken`) and per-user LaPis namespaces via `LAPIS_PROJECT_KEY` (spec §2, §7). The runtime auth reads keys from the env files above and is **independent of `clerk` CLI link state** — the link is only needed for `clerk env pull`, `clerk apps`, etc.

## What's next

Phase 3 (real pi + workspace allowlist + session resume) — see `docs/superpowers/specs/2026-09-22-aelvyril-agent-platform-design.md` §12 and the Phase 2 plan's open-items section.