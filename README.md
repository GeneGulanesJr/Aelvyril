# Aelvyril

Spec-centric agent frontend for the GulanesKorp agent platform (pi + PiSubagent + LaPis + PiSandboxed + LayaMCP, all in Docker).
Spec: `docs/superpowers/specs/2026-09-22-aelvyril-agent-platform-design.md` · UI redesign: `docs/superpowers/specs/2026-09-23-agent-spec-centric-ui-redesign.md` · ADRs: `docs/adr/`

## Status: agent spec-centric UI (v1 surface)

Every ask produces a **plan + diff**; non-trivial asks auto-trigger an **agent-driven spec interview** before execution. Threads live at `/thread/[id]` with Plan / Trace / Diff tabs; the gateway exposes `/v1/threads*` (old `/v1/conversations*` paths remain as back-compat aliases). See `docs/superpowers/plans/2026-09-23-agent-spec-centric-ui.md` and the thread-routes section of `docs/ops/gateway.md`.

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
    pnpm test:e2e   # Playwright (requires gateway + web running locally)

> Windows note: this repo is developed under PowerShell — run the check commands one at a time (or use `;`).

## Clerk setup

The gateway enforces Clerk JWT bearer auth (`@clerk/backend.verifyToken`) and per-user LaPis namespaces via `LAPIS_PROJECT_KEY` (spec §2, §7 — see ADR 0002). The runtime auth reads keys from the env files above and is **independent of `clerk` CLI link state** — the link is only needed for `clerk env pull`, `clerk apps`, etc.

## Stack

Per spec §4/§5/§9 (see ADR 0003), the full agent platform runs as five Docker services: `web`, `gateway`, `lapis`, `sandd`, `layamcp`. See `infra/compose.yaml`, `infra/docker/`, and `infra/smoke.sh`. Two upstream patches in sibling repos complete the picture:

- `LaPis/` — `LAPIS_PROJECT_KEY` env override for per-conversation namespaces (ADR 0002).
- `LayaMCP/` — drops broken `mcp.server.fastapi`, mounts SSE on plain FastAPI, adds `/health`.

The `gateway` (8787) and `web` (3000, or 3001 if 3000 is taken on the dev host) are the only published ports locally. In production only Caddy is public (80/443); everything else stays internal, with `web:3000` behind the proxy.

## Abuse caps (spec §10)

- **Rate limit**: 20 req/min/user on `/v1/threads/:id/prompt` (token bucket, capacity 20, refill 20/60 tokens/sec). On exceed: HTTP 429 with `retry-after: 60`.
- **Concurrent-thread cap**: 3 total threads per user. On exceed: HTTP 503 with `{error: "conversation_limit_reached", limit: 3}` (error key kept for compatibility). Delete old threads to free space.
- **Workspace allowlist**: default-deny via `GATEWAY_WORKSPACE_ALLOWLIST` (comma-separated absolute paths). Relative paths and `..` rejected at parse time.
- **1MB body limit**: enforced at the transport layer (Fastify `bodyLimit: 1_048_576`).

## Degraded state (spec §10)

When a session host dies mid-turn the gateway emits a `session_state: degraded` envelope and marks the conversation degraded; the next prompt respawns the child automatically (workspace cwd preserved). The orange error / yellow degraded **banner UI shipped with the chat-first frontend and is not yet ported to the thread surface** — the thread client receives both envelopes (`error` kind, `session_state` kind) and the hook stores `error`, but no banner renders today.

## Observability (spec §11)

- **`/healthz`** — liveness + readiness. Probes backing services via `LAPIS_URL` / `SANDD_URL` / `LAYAMCP_URL` env vars. Returns 503 if any probe fails.
- **`/metrics`** — Prometheus text format. Counters + a histogram for request rate, latency, conv-creation, prompt counts, rate-limit / cap / workspace rejections, active session hosts.
- **Structured logs** — Fastify pino JSON to stdout. Override with `GATEWAY_LOG=silent` for dev.
- **Request IDs** — every response carries `X-Request-Id` (8-char random base36) for log correlation.
- **Response compression** — gzip + deflate above 1 KB. SSE streams are excluded (would break `Last-Event-ID` reconnect).

## Thread surface

**Wired in the thread UI** (`/thread/[id]`):

- **Spec interview** — heuristic (`GATEWAY_SPEC_HEURISTIC=off` to disable) decides auto-trigger; force via "Ask + spec"
- **Plan / Trace / Diff tabs** — diff lines color-coded; spec drafts editable inline (goal / files / plan / risks)
- **Lifecycle** — draft → spec'ing → running → reviewed → merged / abandoned; approve / abandon / retry routes
- **Rename** (inline edit in the thread header, PATCH round-trip)
- **Stream reconnect** — Last-Event-ID survives drops

**Gateway + client capability, not yet wired in the thread UI** (carried over from the chat-first frontend):

- **Search** — was client-side title filtering; needs a sidebar search box (the gateway list route returns full titles)
- **Delete** — `DELETE /v1/threads/:id` route + client method exist; no UI affordance yet
- **Stop/abort** — `POST /v1/threads/:id/abort` route + client method exist; the thread UI offers abandon (kills the session host) instead
- **Steer-queued sends** — the prompt route still accepts `streamingBehavior: "steer"`; the thread UI doesn't send it
- **Banners** — see Degraded state above

## Ops

- **Runbooks** for every service: `docs/ops/{gateway,lapis,sandd,layamcp}.md` + `docs/ops/secrets.md`
- **Smoke verification**: `./infra/smoke.sh` (or `./infra/smoke.sh --down` to tear down after)

## Optional polish (not blocking v1)

- Clerk Test Helper magic-link setup for full sign-in E2E (needs Clerk dashboard test mode — out of repo scope)
- OpenTelemetry tracing across web + gateway + pi child (correlate traces through the SSE stream)

See `docs/superpowers/specs/2026-09-22-aelvyril-agent-platform-design.md` §12 for the full phase roadmap.
