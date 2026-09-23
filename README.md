# Aelvyril

Chat-first frontend for the GulanesKorp agent platform (pi + PiSubagent + LaPis + PiSandboxed + LayaMCP, all in Docker).
Spec: `docs/superpowers/specs/2026-09-22-aelvyril-agent-platform-design.md` · ADRs: `docs/adr/`

## Dev (no pi required)

    # terminal 1 — gateway with scripted fake child
    GATEWAY_PORT=8787 PI_FAKE=1 CLERK_SECRET_KEY=sk_test_placeholder GATEWAY_ALLOWED_ORIGIN=http://localhost:3000 pnpm --filter @aelvyril/gateway start
    # terminal 2 — web (needs real Clerk dev keys in apps/web/.env)
    pnpm --filter @aelvyril/web dev

Open http://localhost:3000.

## Checks

    pnpm -r typecheck && pnpm -r lint && pnpm -r test

> Windows note: this repo is developed under PowerShell — run the check commands one at a time (or use `;`).
