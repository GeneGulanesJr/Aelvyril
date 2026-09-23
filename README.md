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

The gateway enforces Clerk JWT bearer auth (`@clerk/backend.verifyToken`) and per-user LaPis namespaces via `LAPIS_PROJECT_KEY` (spec §2, §7). The runtime auth reads keys from the env files above and is **independent of `clerk` CLI link state** — the link is only needed for `clerk env pull`, `clerk apps`, etc.

## Stack

Per spec §4/§5/§9, the full agent platform runs as five Docker services: `web`, `gateway`, `lapis`, `sandd`, `layamcp`. See `infra/compose.yaml`, `infra/docker/`, and `infra/smoke.sh`. Two upstream patches in sibling repos complete the picture:

- `LaPis/` — `LAPIS_PROJECT_KEY` env override for per-conversation namespaces.
- `LayaMCP/` — drops broken `mcp.server.fastapi`, mounts SSE on plain FastAPI, adds `/health`.

The `gateway` is the only service with a published port in dev (3000) — production publishes `web:3000` and the rest stays internal.

## Abuse caps (spec §10)

- **Rate limit**: 20 req/min/user on `/v1/conversations/:id/prompt` (token bucket, capacity 20, refill 20/60 tokens/sec). On exceed: HTTP 429 with `retry-after: 60`.
- **Concurrent-conversation cap**: 3 total conversations per user. On exceed: HTTP 503 with `{error: "conversation_limit_reached", limit: 3}`. Delete old conversations to free space.
- **Workspace allowlist**: default-deny via `GATEWAY_WORKSPACE_ALLOWLIST` (comma-separated absolute paths). Relative paths and `..` rejected at parse time.
- **1MB body limit**: enforced at the transport layer (Fastify `bodyLimit: 1_048_576`).

## Banners (spec §10)

- **Error banner** (orange, dismissable): per-request failures (network, 4xx/5xx).
- **Degraded banner** (yellow, persistent): shown when the gateway's `session_state: degraded` envelope arrives. Disappears when a turn settles back to idle/streaming. Tells the user that chat continues and the next prompt will respawn the session host automatically.

## What's next

Phase 5 hardening (spec §10): ✅ rate limit, ✅ concurrent cap, ✅ workspace allowlist, ✅ degraded banner. Remaining:

- Playwright E2E (spec §11): sign-in gate, send/stream/receive, reconnect replay.
- Ops runbooks (per-service troubleshooting for `lapis`, `sandd`, `layamcp`).
- Production deploy hardening (TLS, secret rotation, observability).

See `docs/superpowers/specs/2026-09-22-aelvyril-agent-platform-design.md` §12 for the full phase roadmap.
