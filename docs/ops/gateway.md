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

### HTTP 403 `forbidden` on `/v1/admin/*`

#76 default-deny: `GET /v1/admin/update/status` and `POST /v1/admin/update`
require the calling user id to be listed in `GATEWAY_ADMIN_USER_IDS`
(comma-separated Clerk user ids). Unset, **nobody** is an admin. The apply
route restarts the gateway and pulls `origin/main`, so it is never available
to ordinary signed-in users.

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

Per-user thread cap (default **30** since #83 — threads are cheap rows;
see ADR-0005). User must delete an old thread (`DELETE /v1/threads/:id`)
before creating new ones. To change the cap, pass
`maxConversationsPerUser` via `AppOptions` (compose wiring: edit
`apps/gateway/src/index.ts`).

### HTTP 202 `{accepted: true, queued: true}` from /prompt

Not an error (#83): the user already has
`GATEWAY_MAX_RUNNING_HOSTS` (default 2) hosts running, so the prompt was
**durably queued** and will start automatically when a slot frees — no
browser tab required (ADR-0005). A `409 already_queued` means the same
thread already has a queued prompt; `POST /v1/threads/kill-all` drops a
user's queued work.

### HTTP 403 `cost_cap_reached`

The thread's cumulative cost (`GATEWAY_MAX_THREAD_COST_USD`, issue #84)
was reached; the thread is also marked `blocked` with reason `capped`
(orange banner in the web UI). Raise the env var (restart) or abandon the
thread. The completed turn still delivered its output — only the *next*
prompt is refused.

### HTTP 429 `too_many_streams`

Per-user SSE stream cap (`GATEWAY_MAX_SSE_STREAMS`, default 10, #85).
The web client opens one stream per thread page; more than 10 concurrent
thread tabs for one user trip this.

### SSE stream hangs after page reload

Reconnect with `Last-Event-ID: <last-seq-seen>` to resume. The web
client (`apps/web/lib/api.ts openStream`) does this automatically.

### Child process exits mid-turn

`Supervisor.onProtocolEvent` `exit` handler fires → `setConversationState(degraded)` →
emits `session_state: degraded` envelope. Next prompt respawns the child
(workspace cwd preserved). The thread UI shows a persistent degraded banner
(`apps/web/components/thread/banner.tsx`) while the session is degraded.

### Blocked threads ("Needs you" orange banner)

Issue #84 escalation state (`state: "blocked"`) with a reason:

- `capped` — the per-thread budget (`GATEWAY_MAX_THREAD_COST_USD`) was hit
  at the settle-time usage harvest.
- `dialog` — the agent raised a blocking `extension_ui_request` dialog
  while `GATEWAY_DIALOG_MODE=blocked`. Default mode is `auto-responder`,
  which answers dialogs **cancelled** so headless runs keep moving (spec
  §14.3) and only surfaces a `dialog` envelope for observability.
- `question` — reserved for the spec-interview contract path.

Set `GATEWAY_DIALOG_MODE=blocked` if you want autonomy to stop at any
agent dialog instead of declining it.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GATEWAY_PORT` | 8787 | Listen port |
| `GATEWAY_HOST` | `::` (dual-stack); `127.0.0.1` in PI_FAKE dev mode | Listen host (#78: the fake verifier refuses non-loopback hosts) |
| `GATEWAY_DB` | ./data/gateway.db | SQLite path |
| `GATEWAY_IDLE_MS` | 300000 | Session-host idle reap (inactivity-based) |
| `GATEWAY_LOG` | (on) | `silent` to disable pino logs |
| `GATEWAY_ALLOWED_ORIGIN` | (none) | Comma-separated CORS allowlist |
| `GATEWAY_WORKSPACE_ALLOWLIST` | (deny all) | Comma-separated absolute paths |
| `SSE_HEARTBEAT_MS` | 15000 | SSE keepalive interval |
| `CLERK_SECRET_KEY` | (required) | Real token verification |
| `CLERK_AUTHORIZED_PARTIES` | (unset) | #85: comma-separated origins to pin the token `azp` claim |
| `PI_FAKE` | (off) | `1` = dev verifier + fake child (#78: verifier accepts ANY token; loopback-only, loud banner at boot) |
| `GATEWAY_ADMIN_USER_IDS` | (deny all) | #76: comma-separated Clerk user ids allowed to call `/v1/admin/*` |
| `GATEWAY_METRICS_SECRET` | (unset) | #85: when set, `/metrics` requires `Authorization: Bearer <secret>` |
| `GATEWAY_MAX_SSE_STREAMS` | 10 | #85: per-user concurrent SSE streams |
| `GATEWAY_SSE_REPLAY_PAGE` | 500 | #85: events per replay page (client resumes via Last-Event-ID) |
| `GATEWAY_EVENT_RETENTION` | 10000 | #85: max events kept per thread (0 disables pruning) |
| `GATEWAY_MAX_THREAD_COST_USD` | (unset) | #84: per-thread budget; exceeding blocks the thread |
| `GATEWAY_DIALOG_MODE` | auto-responder | #84: `blocked` escalates agent dialogs to the needs-you state |
| `GATEWAY_MAX_THREADS` | 30 | #83: per-user thread rows (cheap) |
| `GATEWAY_MAX_RUNNING_HOSTS` | 2 | #83: per-user concurrent running hosts (the real cap) |
| `GATEWAY_MAX_SESSION_HOSTS` | 100 | #83: global live-host ceiling |
| `GATEWAY_QUEUE_INTERVAL_MS` | 2000 | #83: queue-runner tick |

Note: `GATEWAY_MAX_THREADS` / `GATEWAY_MAX_RUNNING_HOSTS` /
`GATEWAY_MAX_SESSION_HOSTS` / `GATEWAY_QUEUE_INTERVAL_MS` are read in
`apps/gateway/src/index.ts` (compose/dev entrypoint); tests override them
via `AppOptions`.

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
- `POST /v1/threads/kill-all` — #84 global kill switch: abandons every live
  (streaming/blocked/queued) thread for the caller, kills their hosts, and
  drops their queued prompts; returns `{abandoned: n}`

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

Unauthenticated by default — set `GATEWAY_METRICS_SECRET` (#85) to require
`Authorization: Bearer <secret>` on scrapes (e.g. when the gateway is
exposed directly rather than behind a gating reverse proxy).

```sh
curl -s http://127.0.0.1:8787/metrics
# or, with the scrape secret set:
curl -s -H 'Authorization: Bearer <secret>' http://127.0.0.1:8787/metrics
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
| `aelvyril_sse_streams_rejected_total` | counter | — |
| `aelvyril_cost_cap_rejections_total` | counter | — |
| `aelvyril_queued_prompts_total` | counter | — |
| `aelvyril_active_session_hosts` | gauge | — |

For TLS-protected scraping, put a `reverse_proxy gateway:8787` block in
`infra/docker/Caddyfile` (the example has a commented template).

### TLS termination

Production deploys route through the Caddy service in `infra/compose.yaml`:

- Caddy listens on 80/443 (only public ports).
- Auto-provisions Let's Encrypt certs via ACME for `AELVYRIL_DOMAIN`.
- Certs + account keys persist in `caddy-data` + `caddy-config` volumes.
- All other services stay internal on the `aelvyril-net` bridge.

#79: the browser reaches the gateway **same-origin** via Caddy's `/v1/*`
route (SSE flushed per-write, `flush_interval -1`) — build the web bundle
with an empty `NEXT_PUBLIC_GATEWAY_URL` for this. The host bindings for
web/gateway are loopback-only (dev + smoke); never point
`GATEWAY_BIND_HOST`/`WEB_BIND_HOST` at a public interface. Caddy also
sets the security headers (CSP with `frame-ancestors 'none'`,
`X-Frame-Options: DENY`, HSTS, nosniff); the gateway itself answers with
`x-content-type-options`/`x-frame-options` on every response. Set
`CSP_CLERK_ORIGINS` to your Clerk Frontend API origins or the CSP will
block sign-in.

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
