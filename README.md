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

## Phase 1 pipeline (live)

The memory consolidation pipeline is implemented and runs nightly (03:00 server
time) inside `aelvyril-server` via cron → `deploy/nightly.sh` → `src/nightly.mjs`:

```
inbox/<instance>/<ts>.json   ──▶  staging_observations  ──▶  observations (canonical)
(pushed by LaPis instances         (origin_instance,              (dedup + FTS)
 after each dream cycle)            source_id upsert)                 │
                                                                      ▼
                                              conflicts ──▶ pass B (optional GLM)
                                                                │ merge → new row + supersedes
                                                                │ contradicts → review-<date>.md
reports/conflicts-<date>.md ◀───────────────────────────────────┘
                                                                      ▼
                                              digests/<project>.md  (agents read on demand)
```

- **Pass A (rule-based, `src/merge.mjs`):** ingest inbox batches → staging
  (upsert by `(origin_instance, source_id)`); promote into canonical with exact
  `(project, topic_key, title)` dedup (newest `updated_at` wins); superseded
  relations become soft-deletes; FTS rebuild; cross-instance title conflicts
  on the same `(project, topic_key)` → `reports/conflicts-<date>.md`.
- **Pass B (semantic, `src/glm-consolidate.mjs`):** env-gated. Reads each
  conflict, asks GLM to merge or flag. Merge = new canonical row + soft-deleted
  sources with `supersedes` relations (history preserved); contradicts = both
  rows kept + `reports/review-<date>.md`. No key → skipped gracefully.
  Config via env: `GLM_BASE_URL`, `GLM_API_KEY`, `GLM_MODEL`, `GLM_API`
  (`anthropic` for the z.ai Anthropic-compatible endpoint; default OpenAI-style).
- **Digests (`src/digest.mjs`):** per-project markdown, grouped by type
  (decision → architecture → bugfix → pattern → preference → learning), newest
  first, footer with counts. Read-only pull path — instances never write back.

### Batch contract (LaPis client → Aelvyril server)

```json
{
  "instance": "devbox",
  "pushed_at": "2026-08-30T10:00:00Z",
  "rows": [ { ...LaPis observation row..., "origin_instance": "devbox" } ],
  "superseded_ids": [ { "source_id": 2, "relation": "supersedes", "newer_source_id": 3 } ]
}
```

Dropped at `inbox/<instance>/<timestamp>.json`; archived to `processed/` after
merge. Only distillable rows (decision/architecture/bugfix/pattern/preference/
learning, not deleted, not expired) enter the canonical DB.

### What the vault does NOT do

- No write-back into instance memory DBs (digests are read-only pull).
- No embeddings / vector search. No code-index tables.
- No live sync — nightly cadence, deltas only.
- Never auto-deletes on contradiction — human review file is the safety valve.

## Services (this compose)

| Service | Port | Purpose |
|---|---|---|
| `aelvyril-server` | 2322 (SSH), 8420 (API) | Node runtime, provisioning target |
| `aelvyril-sqld` | 8480 | Self-hosted Turso (libSQL server) |

Persistent data: host dataset `MasterDisk/aelvyril` mounted at `/data`
(app, staging, digests) and `/data/sqld` inside sqld (canonical DB).

## License

MIT
