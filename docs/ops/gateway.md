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

The gateway doesn't ship a structured logger by default — stderr-only
text from Fastify + child stderr. In dev, logs include envelope `seq`
numbers, conversation IDs, and child PIDs.

```sh
# Dev: tail the foreground process output
pnpm --filter @aelvyril/gateway start 2>&1 | tee /tmp/gateway.log

# Prod: docker logs
docker compose -f infra/compose.yaml logs -f gateway

# Filter for envelope publish errors (DB connection issues)
grep -E 'SqliteError|not open|database is locked' /tmp/gateway.log
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

Per-user rate limit on `/v1/conversations/:id/prompt` (default 20/min).
Returns `Retry-After: 60`. Either raise the limit (override the
`RateLimiter` via `AppOptions.rateLimiter` in tests; in prod, edit the
token-bucket params in `apps/gateway/src/app.ts`) or wait 60s.

### HTTP 503 `conversation_limit_reached`

Per-user concurrent-conversation cap (default 3). User must delete an
old conversation (`DELETE /v1/conversations/:id`) before creating new
ones. To raise the cap, set `GATEWAY_MAX_CONVERSATIONS_PER_USER` in the
env or override `maxConversationsPerUser` in `AppOptions`.

### SSE stream hangs after page reload

Reconnect with `Last-Event-ID: <last-seq-seen>` to resume. The web
client (`apps/web/lib/api.ts openStream`) does this automatically.

### Child process exits mid-turn

`Supervisor.onProtocolEvent` `exit` handler fires → `setConversationState(degraded)` →
emits `session_state: degraded` envelope. The web UI shows the persistent
degraded banner. Next prompt respawns the child (workspace cwd preserved).

## Database

SQLite at `GATEWAY_DB` (default `./data/gateway.db`). WAL mode.
Conversation history + event log live here. To reset (DESTRUCTIVE):

```sh
# Stop the gateway first
kill <pid>
rm apps/gateway/data/gateway.db*
# Restart — the Store constructor recreates schema + namespace index
pnpm --filter @aelvyril/gateway start
```

`store.test.ts` covers the migration path for pre-namespace DBs (legacy
`platform` namespace backfill).

## Scaling notes

In-memory rate limiter + token bucket live in the gateway process.
Single-process only. To scale horizontally:

1. Swap `createRateLimiter` for `@fastify/rate-limit` with Redis backend.
2. Move the SQLite event log to Postgres or similar (multiple writers).
3. `Supervisor` already supports multiple processes (child spawn is
   independent), but session-host cwd state needs to be persisted in
   `Store` (Phase 3 already does this — `getConversationById(id).workspace`).
