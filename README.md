# Aelvyril

Self-hosted agent memory & asset platform. Collects post-dream distilled memories
from Pi/LaPis instances, consolidates them into one canonical libSQL (Turso) store,
syncs skills/extensions between machines, and exposes an API + dashboard.

> Status: scaffolding — see `.hermes/plans/` in the Hermes workspace for the
> phased implementation plan (Phase 1: memory pipeline, Phase 2: server+API,
> Phase 3: dashboard, Phase 4: asset sync).

## Architecture

```
Pi instances (devbox, PC, ...)          Aelvyril server (own container)
┌─────────────────────┐                 ┌──────────────────────────────┐
│ LaPis memory.db     │  dream delta    │  Fastify API  :8420          │
│ local skills/exts   │ ──────────────▶ │  agent registry + auth       │
└─────────────────────┘                 │        │                     │
                                        │        ▼                     │
                                        │  sqld (libSQL) :8480         │
                                        │  canonical distilled DB      │
                                        └──────────────────────────────┘
```

- **Memories:** one-way distillation. Local DBs stay primary; only dream-survived,
  high-trust memories (decisions, architecture, bugfixes, patterns) reach the vault.
- **Assets:** byte-exact file sync (skills, extensions, packages) — newest wins,
  pin-protected, no LLM involved.
- **Local-first:** instances keep working when the server is down.

## Services (this compose)

| Service | Port | Purpose |
|---|---|---|
| `aelvyril-server` | 2322 (SSH), 8420 (API) | Node runtime, provisioning target |
| `aelvyril-sqld` | 8480 | Self-hosted Turso (libSQL server) |

Persistent data: host dataset `MasterDisk/aelvyril` mounted at `/data`
(app, staging, digests) and `/data/sqld` inside sqld (canonical DB).

## License

MIT
