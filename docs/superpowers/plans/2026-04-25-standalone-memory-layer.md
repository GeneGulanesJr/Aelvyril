# Plan: Standalone Memory Layer Pi Package

## Goal

Build a fully standalone pi package (`@genegulanesjr/memory-layer`) that provides persistent memory with FTS5 search, trust scoring, and symbol anchoring. Zero external dependencies — one JS file, one SQLite DB.

**Scope**: Local install only (`pi install /path/to/package`). npm publish and GitHub repo setup are separate follow-up tasks.

## Current State

| Component | Location | Lines | External deps |
|---|---|---|---|
| `memory-store.js` | `~/.pi/agent/skills/memory-layer/` | 583 | Engram MCP server, sqlite3 CLI |
| `schema.sql` | same | 69 | — |
| `SKILL.md` | same | 250 | Engram MCP tools (14 tools referenced) |
| Bridge DB | `~/.pi/memory/memory.db` | 6 tables | — |
| Engram DB | `~/.engram/engram.db` | 5 tables + FTS5 + sync tables | Engram MCP server |

**The problem**: The memory layer is split across two databases and two processes. Engram owns observations/FTS5, bridge owns metadata. Without Engram MCP server configured, nothing works.

## What Engram Provides — Actual Usage Audit

| Feature | Used? | Data | Notes |
|---|---|---|---|
| `observations` table (CRUD) | ✅ | 65 rows | Core memory store |
| `observations_fts` (FTS5 search) | ✅ | — | `engram_mem_search` |
| `user_prompts` table | ✅ | 1 row | `engram_mem_save_prompt` |
| `prompts_fts` (FTS5) | ✅ | — | Mirrors user_prompts |
| `sessions` table | ✅ | — | Session tracking (replaced by `session_log`) |
| `sync_id` column | ⚠️ | 65 non-null | Auto-generated UUIDs, but cloud sync is broken (stuck at pending) — safe to drop |
| `normalized_hash` column | ⚠️ | 65 non-null | Auto-generated hashes, but dedup is disabled — safe to drop |
| `last_seen_at` column | ⚠️ | 48 non-null | Timestamps, but never queried by anything — safe to drop |
| `revision_count` column | ⚠️ | 2 rows have value=2 | Indicates 2 observations were updated — safe to drop (we track `updated_at`) |
| Cloud sync (`sync_*` tables) | ❌ | lifecycle=pending, 0 chunks | Never completed — drop entirely |
| Deduplication logic | ❌ | Hashes exist but never acted on | Drop entirely |

**Verdict**: We use ~40% of Engram functionally. The rest is auto-generated bookkeeping for features that never worked.

## Target Architecture

```
@genegulanesjr/memory-layer/
├── package.json
├── LICENSE
├── README.md
└── skills/
    └── memory-layer/
        ├── SKILL.md              # Protocol doc — references scripts/ relative
        └── scripts/
            └── memory-store.js   # Single-file engine (~800 lines)
```

**Single database**: `~/.pi/memory/memory.db` — absorbs all tables from both DBs.
**Single entry point**: `memory-store.js` — absorbs all Engram MCP tool functionality as subcommands.
**Zero external dependencies**: No MCP server, no Engram, no npm packages. Just `sqlite3` CLI.

## Tasks

### Phase 1: New Schema — Merge Both DBs Into One

- [ ] **1.1 Write new `schema.sql`** — Merge Engram's useful tables into bridge DB:
  - Keep all existing bridge tables: `symbol_links`, `trust_adjustments`, `procedural_memory`, `procedural_steps`, `session_log`, `session_recalls`
  - Add from Engram: `observations` (simplified — drop `sync_id`, `normalized_hash`, `revision_count`, `duplicate_count`, `last_seen_at`, `tool_name` columns), `observations_fts`, `user_prompts`, `prompts_fts`
  - Drop Engram's `sessions` table — use existing `session_log` instead (update `observations.session_id` to be TEXT, no FK constraint — maps to `session_log.id` or `'legacy'` for imported data)
  - Add FTS5 triggers for auto-sync (same pattern Engram uses)
  - Add proper indexes (project, type, scope, topic_key, created_at, deleted_at)

- [ ] **1.2 Add schema versioning** — `PRAGMA user_version = 1` so future upgrades can detect and migrate

- [ ] **1.3 Add startup checks in `ensureDb()`**:
  1. Check `sqlite3` binary exists on PATH (hard fail with clear message if missing: "sqlite3 not found — install via `apt install sqlite3` or `brew install sqlite3`")
  2. Check FTS5 support by running `CREATE VIRTUAL TABLE IF NOT EXISTS __fts5_probe USING fts5(x); DROP TABLE __fts5_probe;` (hard fail with clear message if unsupported)

### Phase 2: Engine — Absorb Engram Tool Functions

Each `engram_mem_*` MCP tool becomes a `memory-store.js` subcommand:

- [ ] **2.1 `save`** — INSERT into `observations`. Params: `--title`, `--type`, `--content`, `--project`, `--scope` (default `project`), `--topic-key`, `--session-id` (auto-detects latest session if omitted). Returns `{ id, title }`.

- [ ] **2.2 `search`** — FTS5 MATCH query. Params: `--query`, `--project`, `--type`, `--scope`, `--limit` (default 10). Uses BM25 ranking. Returns `{ results: [{ id, title, type, project, snippet }] }`.

- [ ] **2.3 `context`** — Returns recent sessions + recent observations for a project. Params: `--project`, `--limit` (default 20). Same output shape as old `engram_mem_context`.

- [ ] **2.4 `get`** — SELECT full observation by `--id`. Returns `{ id, title, content, type, project, scope, topic_key, created_at, updated_at }`.

- [ ] **2.5 `update`** — UPDATE observation fields by `--id`. Params: any combination of `--title`, `--content`, `--type`, `--project`, `--scope`, `--topic-key`. Updates `updated_at` automatically.

- [ ] **2.6 `delete`** — Soft-delete by `--id`. Sets `deleted_at = datetime('now')`. Supports `--hard` flag for permanent delete.

- [ ] **2.7 `timeline`** — SELECT observations in ID range around `--id`. Params: `--before` (default 5), `--after` (default 5). Returns chronological context.

- [ ] **2.8 `suggest-topic-key`** — Normalize `--title` → stable key string. Same algorithm as Engram (lowercase, replace non-alphanum with hyphens, collapse consecutive hyphens, trim).

- [ ] **2.9 `save-prompt`** — INSERT into `user_prompts`. Params: `--content`, `--project`, `--session-id`.

- [ ] **2.10 `capture-passive`** — Parse `## Key Learnings:` section from `--content`. Regex handles: `- ` bullets, `* ` bullets, numbered lists (`1. `, `1)`), multi-line items (capture until next bullet, next heading, or double newline). INSERT each item as a separate observation.

- [ ] **2.11 `stats`** — COUNT queries: total observations, per-project counts, total sessions, total prompts. Returns summary object.

- [ ] **2.12 `session-summary`** — INSERT observation with `type=session_summary`. Params: `--content`, `--project`, `--session-id`. Convenience wrapper around `save`.

**Existing subcommands preserved (already implemented, may need minor updates):**

- [ ] **2.13 `session-start`** — Already exists. Ensure it works with new unified schema (no ATTACH needed for compaction since everything is in one DB now). Params: `--project`. Returns `{ sessionId, sessionCount, consolidateDue, hasIncompletePreviousSession, incompleteSessionId, compacted }`.

- [ ] **2.14 `session-end`** — Already exists. No changes needed. Params: `--id`, `--memories`, `--auto`. Returns `{ ok, sessionId, trustRecovery }`.

### Phase 3: Migration — Import Existing Data

- [ ] **3.1 Write `migrate.js`** — One-time migration script:
  1. **Pre-flight checks**: Verify both DBs exist, check sqlite3 on PATH, check FTS5 availability, print current row counts
  2. **Backup**: Copy `memory.db` → `memory.db.bak.{timestamp}`, copy `engram.db` → `engram.db.bak.{timestamp}`
  3. **Schema migration** (inside a single transaction via ATTACH):
     - `ATTACH DATABASE 'engram.db' AS engram`
     - Create new tables (observations, FTS5, user_prompts, prompts_fts) in bridge DB
     - `INSERT INTO observations SELECT ... FROM engram.observations` (mapping kept columns, defaulting dropped columns)
     - `INSERT INTO user_prompts SELECT ... FROM engram.user_prompts`
     - Rebuild FTS5 indexes via `INSERT INTO observations_fts(observations_fts) VALUES('rebuild')`
     - `DETACH DATABASE engram`
     - `COMMIT`
  4. **Verify**: Compare row counts (observations: expect 65, prompts: expect 1, symbol_links: expect 36)
  5. **Log warnings**: Report any observations with non-null values in dropped columns (`sync_id`: 65 rows, `normalized_hash`: 65 rows, `last_seen_at`: 48 rows, `revision_count`: 2 rows with value=2)
  6. **Report**: Print migration summary with before/after counts

  **Crash safety**: The migration wraps all writes in a single SQLite transaction (`BEGIN; ... COMMIT;`). If the script crashes mid-run, the transaction rolls back and the backup files allow manual recovery. Using `ATTACH` keeps everything in one connection — no JSON/CSV intermediary.

- [ ] **3.2 Run migration** — Execute `migrate.js`, verify output, confirm all 65 observations + 1 prompt + 36 symbol_links preserved

- [ ] **3.3 Snapshot post-migration state** — Run `memory-store.js stats` and save output to `~/.pi/memory/migration-report-{timestamp}.txt` along with row counts for all tables. This is the baseline for verifying correctness later.

- [ ] **3.4 Remove `migrate.js`** — After successful migration and snapshot, delete the script. It's a one-time tool, not part of the package.

### Phase 4: SKILL.md Rewrite — Remove All Engram References

- [ ] **4.1 Write minimal SKILL.md stub first** (do this BEFORE Phase 3 so active sessions don't follow stale Engram instructions):
  ```markdown
  ## ⚠️ Migration in progress
  This skill is being upgraded to standalone. Use `memory-store.js` subcommands directly.
  See plan: docs/superpowers/plans/2026-04-25-standalone-memory-layer.md
  ```

- [ ] **4.2 Rewrite tool reference table** — Replace 14 `engram_mem_*` MCP tools with `memory-store.js` subcommands:
  | Old (Engram MCP) | New (CLI) |
  |---|---|
  | `engram_mem_save` | `memory-store.js save --title X --content Y` |
  | `engram_mem_search` | `memory-store.js search --query X` |
  | `engram_mem_context` | `memory-store.js context --project X` |
  | ... etc for all 14 tools |

- [ ] **4.3 Rewrite session start protocol** — 3 steps: `session-start` → `context` → `auto-link`. No Engram calls.

- [ ] **4.4 Rewrite session shutdown** — 2 steps: `session-summary` + `session-end --auto`. No Engram calls.

- [ ] **4.5 Rewrite "How To Save"** — Replace `engram_mem_save(title=..., content=...)` syntax with `node scripts/memory-store.js save --title "..." --content "..."`. Include copy-paste examples.

- [ ] **4.6 Rewrite graceful degradation** — Three failure modes: (1) sqlite3 not on PATH → clear error message, (2) memory-store.js fails → session works without persistence, (3) DB corrupted → suggest deleting `~/.pi/memory/memory.db` to re-initialize. No Engram failure mode.

- [ ] **4.7 Remove all absolute path references** — SKILL.md uses `node ./scripts/memory-store.js ...` (with `./` prefix) relative to the skill directory only. No `~/.pi/agent/skills/...` anywhere.

- [ ] **4.8 Use `path.resolve(__dirname, ...)` in memory-store.js** — DB path uses `$HOME` (already absolute). Schema path becomes `path.join(__dirname, 'schema.sql')` so it resolves correctly regardless of where `node` is invoked from.

### Phase 5: Package Structure

- [ ] **5.1 Create `package.json`** — Follows pi package spec:
  ```json
  {
    "name": "@genegulanesjr/memory-layer",
    "version": "1.0.0",
    "description": "Standalone persistent memory for Pi — FTS5 search, trust scoring, symbol anchoring, procedural workflows. Zero external dependencies.",
    "keywords": ["pi-package", "memory", "persistent-memory", "trust-scoring"],
    "pi": { "skills": ["./skills"] },
    "license": "MIT"
  }
  ```

- [ ] **5.2 Verify relative path resolution** — Before finalizing SKILL.md, test that pi resolves `scripts/memory-store.js` correctly from the installed skill directory. The skill's SKILL.md lives at `skills/memory-layer/SKILL.md`, so `scripts/memory-store.js` resolves to `skills/memory-layer/scripts/memory-store.js`.

- [ ] **5.3 Create `README.md`** — Installation, features, architecture, subcommand reference table, migration from Engram (for existing users), troubleshooting.

- [ ] **5.4 Create `LICENSE`** — MIT

- [ ] **5.5 Test local install** — `pi install ./local/path` on this machine, verify pi discovers the skill, verify a session start/end cycle works

### Phase 6: Update AGENTS.md

- [ ] **6.1 Remove all `engram_mem_*` references** — Replace with `memory-store.js` subcommands throughout
- [ ] **6.2 Simplify session protocol** — Start: `memory-store.js session-start` → `memory-store.js context`. End: `memory-store.js session-summary` → `memory-store.js session-end --auto`
- [ ] **6.3 Remove Engram from graceful degradation** — No more "Engram unavailable" case

## What Gets Dropped

| Feature | Why | Data impact |
|---|---|---|
| Engram MCP server dependency | Replaced by memory-store.js subcommands | None — functionality preserved |
| Cloud sync (`sync_*` tables, `sync_id` column) | Never worked — lifecycle stuck at pending, 0 chunks pulled | `sync_id`: 65 rows had auto-generated UUIDs — logged in migration, dropped |
| Deduplication (`normalized_hash`, `duplicate_count` columns) | Hashes existed but dedup was never enabled | `normalized_hash`: 65 rows had hashes — logged in migration, dropped |
| `last_seen_at` column | Timestamps populated but never queried | 48 rows had values — logged in migration, dropped |
| `revision_count` column | 63 rows = 1, 2 rows = 2 — never acted on | 2 observations (IDs 20, 36) had revision_count=2 — logged, dropped |
| `tool_name` column | 0 non-null rows across all observations | None |
| Engram's `sessions` table | Redundant with `session_log` | Merged — engram session_ids mapped to `'legacy-{id}'` strings |
| Hash-based dedup logic | Not needed — zero accidental duplicates in 65 observations (checked). Agent's "search before saving" rubric + trust scoring handles stale data via compaction | None |

**Note**: `user_prompts` and `prompts_fts` are **kept** — task 2.9 (`save-prompt`) still exists. They are not being dropped.

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Data loss during migration | `migrate.js` backs up both DBs with timestamps before writing. All writes wrapped in a single SQLite transaction — crashes cause rollback, not partial writes. |
| FTS5 not available | Phase 1.3: startup check in `ensureDb()` tests FTS5 with a probe table and prints a clear install message. Also added to success criteria. |
| Agent reads old SKILL.md during development | Phase 4.1: write a minimal migration stub FIRST, before any code changes. |
| Relative path resolution fails after install | Phase 5.2: explicit test before finalizing SKILL.md. |
| `sqlite3` not on PATH | Same risk as current system. `ensureDb()` catches execSync failure and prints install instructions. |
| Dropped columns contain meaningful data | Migration script logs all non-null values in dropped columns before dropping. Manual review possible. |

## Success Criteria

- [ ] `pi install ./path/to/package` works on this machine
- [ ] All 65 existing observations accessible via `memory-store.js search`
- [ ] All 36 symbol_links preserved with correct trust scores
- [ ] 1 user_prompt preserved
- [ ] Session start/end works with 2-step protocol
- [ ] FTS5 concrete test: save observation with unique term "xyzzyspoon", search for "xyzzyspoon", verify it ranks first
- [ ] FTS5 availability check prints clear error on unsupported sqlite3 builds
- [ ] Migration script handles crash recovery (transaction rollback + backup files)
- [ ] Post-migration snapshot saved to `~/.pi/memory/migration-report-{timestamp}.txt`
- [ ] No reference to Engram anywhere in the package (SKILL.md, README.md, memory-store.js)
- [ ] README has clear install instructions
- [ ] `memory-store.js stats` returns correct counts post-migration
- [ ] `session-start` and `session-end` subcommands work with unified schema (no ATTACH)
