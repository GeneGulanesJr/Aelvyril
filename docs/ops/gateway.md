# Gateway ops runbook

The Aelvyril gateway (`apps/gateway/`) is the Fastify service that owns
conversations + event log + session-host lifecycle. This runbook covers
common operational questions.

## Restart

```sh
# Find the running process (dev: tsx, prod: node + node-env-file-if-exists)
ps aux | grep -E 'src/index.ts|node.*index.ts' | grep -v grep

# SIGTERM (graceful — closes store + drains children)
kill <pid>

# Hard kill (only if SIGTERM hangs — child processes need reap)
kill -9 <pid>
```

The Docker compose path (`infra/compose.yaml`) uses `restart: unless-stopped`,
so a process exit triggers an automatic restart.

## Log inspection

The gateway uses [pino](https://getpino.io/) (bundled with Fastify) and
emits **structured JSON logs** to stdout in production. In dev, set
`GATEWAY_LOG=silent` to quiet them.

```sh
# Dev (logs off — keeps terminal clean):
GATEWAY_LOG=silent pnpm --filter @aelvyril/gateway start

# Dev (default — JSON logs to stdout):
pnpm --filter @aelvyril/gateway start

# Pipe through jq for readability:
pnpm --filter @aelvyril/gateway start 2>&1 | jq

# Prod: docker logs (JSON on stdout; pipe through jq in your log
# aggregator / Loki / Datadog pipeline)
docker compose -f infra/compose.yaml logs -f gateway | jq
```

Each log line is one JSON object with at least: `level`, `time`, `msg`,
plus request-scoped fields (`reqId`, `method`, `url`, `statusCode`,
`responseTime`) for request-completion lines.

Filter examples:

```sh
# Errors only
docker logs ... 2>&1 | jq 'select(.level == "error" or .level >= 50)'

# Slow requests (>1s)
docker logs ... 2>&1 | jq 'select(.responseTime > 1000)'

# DB-related errors
docker logs ... 2>&1 | jq 'select(.msg | test("Sqlite|database|not open"))'
```

## Common errors

### "Failed to fetch application (404)" from Clerk CLI

You're logged into the wrong Clerk account. The runtime auth uses
whatever keys are in `apps/gateway/.env`; the CLI link state is separate.
`clerk whoami` shows the CLI's account; the env keys belong to whichever
app you pasted them from.

### HTTP 401 on `/v1/*`

- **No `Authorization` header** → expected, returns 401 with `{error: "unauthorized"}`.
- **Bad bearer token** → Clerk `verifyToken` throws "Invalid JWT form" → 401.
- **Expired session** → Clerk throws → 401. User re-signs in.
- **`CLERK_SECRET_KEY` missing** → gateway refuses to start (throws on init).

### HTTP 400 `workspace_not_allowed`

Spec §10 default-deny. The conversation's `workspace` field isn't in
`GATEWAY_WORKSPACE_ALLOWLIST`. Either add the path to the allowlist
(comma-separated absolute paths) or remove the `workspace` field from
the request body (platform-level chats don't need one).

### HTTP 429 `rate_limited`

Per-user rate limit on `/v1/threads/:id/prompt` (default 20/min).
Returns `Retry-After: 60`. Either raise the limit (override the
`RateLimiter` via `AppOptions.rateLimiter` in tests; in prod, edit the
token-bucket params in `apps/gateway/src/app.ts`) or wait 60s.

### HTTP 503 `conversation_limit_reached`

Per-user concurrent-thread cap (default 3). User must delete an
old thread (`DELETE /v1/threads/:id`) before creating new
ones. To raise the cap, set `GATEWAY_MAX_CONVERSATIONS_PER_USER` in the
env or override `maxConversationsPerUser` in `AppOptions`.

### SSE stream hangs after page reload

Reconnect with `Last-Event-ID: <last-seq-seen>` to resume. The web
client (`apps/web/lib/api.ts openStream`) does this automatically.

### Child process exits mid-turn

`Supervisor.onProtocolEvent` `exit` handler fires → `setConversationState(degraded)` →
emits `session_state: degraded` envelope. Next prompt respawns the child
(workspace cwd preserved). Note: the degraded **banner UI** shipped with the
chat-first frontend and is not yet ported to the thread surface — the thread
client still receives the envelope (see `apps/web/lib/use-thread.ts`).

## Database

SQLite at `GATEWAY_DB` (default `./data/gateway.db`). WAL mode.
Conversation history + event log live here. To reset (DESTRUCTIVE):

```sh
# Stop the gateway first
kill <pid>
rm apps/gateway/data/gateway.db*
# Restart — runMigrations() (called from the Store constructor) recreates
# tables, backfills namespace, and adds the thread status/spec columns
pnpm --filter @aelvyril/gateway start
```

`store.test.ts` covers the migration paths: pre-namespace DBs (legacy
`platform` namespace backfill) and thread status/spec columns
(`status`, `spec_draft`, `spec_questions`, `spec_answers`), including
idempotent re-runs.

### SSE keepalive

SSE streams emit a `: ping\n\n` keepalive every **15 seconds** (spec §6).
The heartbeat is a no-op for SSE-aware consumers but defeats idle
connection reapers in reverse proxies (Caddy, nginx) and load balancers.

If your proxy / LB has a shorter idle timeout than 15s, lower the
heartbeat via `SSE_HEARTBEAT_MS=5000` in `apps/gateway/.env`. The change
applies on next stream open (in-flight streams keep their interval).

## Thread routes (spec-centric UI)

- `GET /v1/threads` — list threads for the authenticated user (wire key stays `conversations`; items are threads)
- `POST /v1/threads` — create a thread
- `GET /v1/threads/:id` — fetch one thread
- `PATCH /v1/threads/:id` — rename
- `DELETE /v1/threads/:id` — delete (cascades events)
- `POST /v1/threads/:id/prompt` — send a prompt (`message`, optional `streamingBehavior`, `specMode: auto|force|off`)
- `POST /v1/threads/:id/abort` — cancel the current turn
- `GET /v1/threads/:id/events` — SSE stream (Last-Event-ID reconnect)
- `PATCH /v1/threads/:id/spec` — submit interview answers (`{kind:"answer", answers}`) or edit a draft field (`{kind:"edit", field, value}`)
- `POST /v1/threads/:id/approve` — approve the draft; status → running
- `POST /v1/threads/:id/abandon` — terminal; kills the session host
- `POST /v1/threads/:id/retry` — re-run; status → running

Back-compat: `/v1/conversations*` still works — GETs 302-redirect to the canonical path; mutations are method-preserving aliases (a 302 would make fetch re-issue them as GETs, dropping method + body). Spec-mode columns (`status`, `spec_draft`, `spec_questions`, `spec_answers`) are added by the idempotent `runMigrations()` on every startup.

## Compression

`@fastify/compress` is wired into the gateway with gzip + deflate
(threshold 1KB). JSON responses above 1KB are compressed automatically
when the client sends `Accept-Encoding: gzip`.

SSE streams (`text/event-stream`) are explicitly excluded — compressing
them would buffer the whole stream and break `Last-Event-ID` reconnect
semantics.

To inspect the negotiated encoding:

```sh
curl -sI -H 'Accept-Encoding: gzip' http://127.0.0.1:8787/v1/threads | grep -i encoding
```

The Caddyfile (`infra/docker/Caddyfile`) also does `encode gzip zstd` on
the proxy side, so prod benefits from compression at both layers.

## Scaling notes

In-memory rate limiter + token bucket live in the gateway process.
Single-process only. To scale horizontally:

1. Swap `createRateLimiter` for `@fastify/rate-limit` with Redis backend.
2. Move the SQLite event log to Postgres or similar (multiple writers).
3. `Supervisor` already supports multiple processes (child spawn is
   independent), but session-host cwd state needs to be persisted in
   `Store` (Phase 3 already does this — `getConversationById(id).workspace`).

## Observability

### Request IDs

Every response carries an `X-Request-Id` header (8-char random base36).
The web client and reverse proxy pass it through; pino logs include
`reqId` automatically. Use it to correlate a single user request across
web + gateway + the spawned pi child's stderr.

```sh
curl -i http://127.0.0.1:8787/healthz | grep -i request-id
# X-Request-Id: k3j9x1b7
```

To trace a specific request end-to-end:

```sh
docker logs ... 2>&1 | jq 'select(.reqId == "k3j9x1b7")'
```

### `/healthz` (liveness + readiness)

Returns 200 when the gateway itself is healthy AND every configured
backing service is reachable (TCP probe); returns 503 if any probe
fails. Use this for K8s readiness checks so a deploy doesn't get
traffic until `lapis` / `sandd` / `layamcp` are reachable.

By default the probe set is empty — the endpoint just returns
`{gateway: {ok: true, uptimeMs: N}, backing: {}}`. To probe specific
services, set env vars:

```sh
LAPIS_URL=lapis:8788 SANDD_URL=sandd:7391 LAYAMCP_URL=layamcp:8765 \
  pnpm --filter @aelvyril/gateway start
```

Response shape:

```json
{
  "gateway": { "ok": true, "uptimeMs": 12345 },
  "backing": {
    "lapis":   { "ok": true,  "latencyMs": 2 },
    "sandd":   { "ok": false, "latencyMs": 2001, "error": "timeout" },
    "layamcp": { "ok": true,  "latencyMs": 1 }
  }
}
```

The compose.yaml wires these env vars automatically in the prod profile.

### `/metrics` (Prometheus text format)

Unauthenticated. Returns counters + a histogram. Scrape from your
Prometheus or OTel collector.

```sh
curl -s http://127.0.0.1:8787/metrics
```

Metrics exposed (spec §11):

| Metric | Type | Labels |
|---|---|---|
| `aelvyril_http_requests_total` | counter | method, route, status |
| `aelvyril_http_request_duration_ms` | histogram | method, route, status |
| `aelvyril_conversation_creations_total` | counter | — |
| `aelvyril_prompt_requests_total` | counter | — |
| `aelvyril_prompt_rejections_total` | counter | — |
| `aelvyril_rate_limited_total` | counter | — |
| `aelvyril_conversation_limit_reached_total` | counter | — |
| `aelvyril_workspace_rejections_total` | counter | — |
| `aelvyril_active_session_hosts` | gauge | — |

For TLS-protected scraping, put a `reverse_proxy gateway:8787` block in
`infra/docker/Caddyfile` (the example has a commented template).

### TLS termination

Production deploys route through the Caddy service in `infra/compose.yaml`:

- Caddy listens on 80/443 (only public ports).
- Auto-provisions Let's Encrypt certs via ACME for `AELVYRIL_DOMAIN`.
- Certs + account keys persist in `caddy-data` + `caddy-config` volumes.
- All other services stay internal on the `aelvyril-net` bridge.

For local dev without a public domain, Caddy falls back to its internal
CA — browsers will show a cert warning. Override `AELVYRIL_DOMAIN=localhost`
to use this.

To rotate certs (e.g., post-key-compromise):

```sh
docker compose -f infra/compose.yaml exec caddy caddy untrust
docker compose -f infra/compose.yaml restart caddy
```

## Secret rotation

See `docs/ops/secrets.md` for the full cadence (Clerk keys, provider
keys, gateway env).
