# @aelvyril/gateway

Agent platform gateway (spec: `docs/superpowers/specs/2026-09-22-aelvyril-agent-platform-design.md` §6).

Owns: conversation records, per-conversation RPC session hosts, the event log
(SQLite, WAL), the SSE stream with `Last-Event-ID` replay, Clerk JWT
verification, abuse caps (rate limit + cap), workspace allowlist, Prometheus
metrics, structured pino logs, request-ID correlation, response compression.

## Run (dev, fake child — no pi needed)

    GATEWAY_PORT=8787 PI_FAKE=1 pnpm --filter @aelvyril/gateway dev

## Run (real pi session hosts)

    GATEWAY_PORT=8787 PI_COMMAND=pi pnpm --filter @aelvyril/gateway dev
    # Optional: pin the provider + model (spec §14):
    PI_PROVIDER=anthropic PI_MODEL=claude-sonnet-4-5 pnpm --filter @aelvyril/gateway dev

## Run (prod via Docker)

See `infra/compose.yaml`. The `gateway` service has `restart: unless-stopped`
+ `--env-file-if-exists` so the operator injects Clerk + provider keys
at deploy time without rebuilding. TLS termination lives in the Caddy
reverse proxy (`infra/docker/Caddyfile`), not in this app.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness + readiness. Probes backing services via env. Returns 503 on probe failure. |
| `GET` | `/metrics` | Prometheus text format. Unauthenticated (internal network only). |
| `POST` | `/v1/conversations` | Create conversation. 503 on per-user cap, 400 on disallowed workspace. |
| `GET` | `/v1/conversations` | List conversations in the caller's namespace. |
| `GET` | `/v1/conversations/:id` | Get one. |
| `PATCH` | `/v1/conversations/:id` | Rename (title). |
| `DELETE` | `/v1/conversations/:id` | Delete + cascade events. |
| `POST` | `/v1/conversations/:id/prompt` | Send prompt. 429 on rate limit. Returns 202 immediately. |
| `POST` | `/v1/conversations/:id/abort` | Abort current turn. |
| `GET` | `/v1/conversations/:id/events` | SSE stream. Supports `Last-Event-ID` reconnect. |

## Env

| Var | Default | Meaning |
|---|---|---|
| `CLERK_SECRET_KEY` | _required_ | Real Clerk secret key for `@clerk/backend.verifyToken`. |
| `GATEWAY_PORT` | `8787` | Listen port (loopback). |
| `GATEWAY_HOST` | `::` | Listen host. Dual-stack so `localhost` resolves over either ::1 or 127.0.0.1. Set to `127.0.0.1` if IPv6 unavailable. |
| `GATEWAY_DB` | `./data/gateway.db` | SQLite path (WAL). Conversations + event log. |
| `GATEWAY_IDLE_MS` | `300000` | Idle reap timeout for session-host child processes. |
| `GATEWAY_ALLOWED_ORIGIN` | _required_ | Comma-separated CORS allow-list for the web app. |
| `GATEWAY_WORKSPACE_ALLOWLIST` | empty (default-deny) | Comma-separated ABSOLUTE paths for workspace allowlist. Relative paths and `..` rejected. |
| `GATEWAY_RATE_LIMIT_PER_MIN` | `20` | Per-user rate limit on `/prompt`. Token-bucket capacity 20, refill 20/60/sec. |
| `GATEWAY_MAX_CONVERSATIONS_PER_USER` | `3` | Per-user cap on total conversations. |
| `GATEWAY_LOG` | not "silent" → JSON logs | Set to `silent` to disable structured pino output (dev). |
| `SSE_HEARTBEAT_MS` | `15000` | SSE keepalive ping interval. Lower for tighter proxy timeouts. |
| `PI_FAKE` | unset | `1` = use the scripted fake child (no real LLM). |
| `PI_COMMAND` | `pi` | Real session-host binary (spec §14: must be on PATH in the gateway image). |
| `PI_PROVIDER` | unset (→ google) | Pinned at spawn. Always pass explicitly (spec §14). |
| `PI_MODEL` | unset (→ default) | Pinned at spawn. |
| `PI_COMMAND_ARGS` | unset | JSON array of extra args (Windows node.exe + cli.js path workaround). |
| `FAKE_DELAY_MS` | `5` | Fake-child per-message delay. |
| `LAPIS_URL` | unset | Enables the `/healthz` probe for LaPis. |
| `SANDD_URL` | unset | Enables the `/healthz` probe for PiSandboxed. |
| `LAYAMCP_URL` | unset | Enables the `/healthz` probe for LayaMCP. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` | unset | Forwarded to `pi` children at spawn time. |

## Architecture

```
Fastify
├── onResponse hook       → request count + duration metrics (Prometheus)
├── onSend hook           → echoes X-Request-Id header
├── /healthz              → runHealthCheck + backing TCP probes
├── /metrics              → metrics.render() (Prometheus text)
└── /v1/*                 → user-scoped routes via Clerk JWT
    ├── POST /v1/conversations         → cap check + workspace allowlist + createConversation
    ├── GET /v1/conversations          → listConversations(namespace)
    ├── GET /v1/conversations/:id      → getConversation(id, namespace)
    ├── PATCH /v1/conversations/:id     → RenameConversationBody zod → renameConversation
    ├── DELETE /v1/conversations/:id    → deleteConversation (cascades events)
    ├── POST /v1/conversations/:id/prompt
    │   ├── rate-limit check (429 + retry-after)
    │   ├── store.getConversationById(id).workspace → cwd
    │   ├── extraEnv: { LAPIS_PROJECT_KEY: namespace }
    │   ├── supervisor.prompt(id, msg, sb, extraEnv, cwd)
    │   └── persist user_message envelope for replay
    ├── POST /v1/conversations/:id/abort  → supervisor.abort(id)
    └── GET /v1/conversations/:id/events   → SSE stream
        ├── hijack reply, write headers (text/event-stream, no-cache)
        ├── bus.replay(id, lastSeq from Last-Event-ID header)
        ├── bus.subscribe(id, writeEnvelope)
        ├── setInterval(: ping, opts.sseHeartbeatMs)
        └── req.raw.on("close", cleanup)

Supervisor (one child per conversation)
├── ensureSession(id, extraEnv, cwd)
│   ├── getConversationById(id).workspace → cwd fallback
│   ├── spawnChild(id, extraEnv, cwd)
│   ├── RpcClient (JSONL, LF-only, no readline — spec §14)
│   ├── rpc.on("event", handleProtocolEvent) — fail-soft per spec §10
│   └── rpc.on("exit", mark degraded — async disposeAll awaits child exit)
├── prompt(id, msg, sb, extraEnv, cwd) — 202 on accept, false on agent rejection
├── abort(id)
└── disposeAll(timeoutMs = 5_000) — graceful shutdown (await child exits)

Store (better-sqlite3, WAL)
├── conversations(id, title, workspace, namespace, state, created_at)
│   └── namespace index for tenant isolation
├── events(conversation_id, seq, ts, kind, payload) — replay source
├── countConversations / countStreaming — for cap checks
└── getConversationById(id) — internal, no namespace check
```

See `docs/adr/0002-lapis-project-key-namespace-injection.md` for the per-conversation namespace contract and `docs/adr/0001-session-hosts-as-child-processes.md` for why child processes exist.

## Checks

    pnpm --filter @aelvyril/gateway typecheck
    pnpm --filter @aelvyril/gateway lint
    pnpm --filter @aelvyril/gateway test
