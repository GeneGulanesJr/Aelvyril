# @aelvyril/gateway

Agent platform gateway (spec: `docs/superpowers/specs/2026-09-22-aelvyril-agent-platform-design.md` §6).

Owns: conversation records, per-conversation RPC session hosts, the event log
(SQLite, WAL), and the SSE stream with Last-Event-ID replay.

## Run (dev, fake child — no pi needed)

    GATEWAY_PORT=8787 PI_FAKE=1 pnpm --filter @aelvyril/gateway dev

## Run (real pi session hosts — Phase 3)

    GATEWAY_PORT=8787 PI_COMMAND=pi pnpm --filter @aelvyril/gateway dev

## Env

| Var | Default | Meaning |
|---|---|---|
| `GATEWAY_PORT` | `8787` | listen port (loopback) |
| `GATEWAY_DB` | `./data/gateway.db` | SQLite path (WAL) |
| `PI_FAKE` | unset | `1` = use the scripted fake child |
| `PI_COMMAND` | `pi` | session host command (real mode) |
| `GATEWAY_IDLE_MS` | `300000` | idle session reap timeout |
