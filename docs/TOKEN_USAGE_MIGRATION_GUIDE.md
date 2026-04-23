# Token Usage Schema Migration Guide — v1 → v2

**Document version:** 1.0  
**Last updated:** 2026-04-23  
**Schema version:** `TOKEN_USAGE_SCHEMA_VERSION = 2`

---

## Summary

v2 adds two fields to `TokenUsageEvent`:

1. `actual_cost_cents: Option<u64>` — Provider-reported cost (preferred over estimation)
2. `tokens_in_cache_write: u64` — Cache-write token count (separate from cache-read)

All existing v1 data is preserved. The migration is **additive only** — no fields were removed or renamed.

---

## What Changed

### New Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `actual_cost_cents` | `Option<u64>` | `None` | Cost reported by the provider (Anthropic, Google). Use when available; fall back to `cost_estimate_cents` when `None`. |
| `tokens_in_cache_write` | `u64` | `0` | Tokens written to cache (typically 25% more expensive than fresh input). When present, `tokens_in_cached` = cache-read only. |

### Changed Behavior

- **Cost preference:** Consumers should check `actual_cost_cents` first, then fall back to `cost_estimate_cents`.
- **Cache accounting:** `tokens_in_cached` no longer includes cache-write tokens. Total cached-related input = `tokens_in_cached + tokens_in_cache_write`.

### Unchanged

- All v1 fields retain the same names, types, and semantics.
- `schema_version` is the only versioning signal; consumers must check it before parsing.
- SQLite store migration is idempotent — safe to run multiple times.

---

## SQLite Migration

The store automatically runs an idempotent migration on startup:

```sql
-- Add actual_cost_cents (nullable)
ALTER TABLE token_usage_events ADD COLUMN actual_cost_cents INTEGER;

-- Add tokens_in_cache_write (default 0)
ALTER TABLE token_usage_events ADD COLUMN tokens_in_cache_write INTEGER NOT NULL DEFAULT 0;
```

**If the columns already exist, the ALTER TABLE is skipped.** No data loss occurs.

---

## Consumer Migration

### Before (v1)

```rust
let cost = event.cost_estimate_cents;
let cached = event.tokens_in_cached;
```

### After (v2)

```rust
// Prefer provider-reported cost
let cost = event.actual_cost_cents.unwrap_or(event.cost_estimate_cents);

// Cache accounting
let total_cached_input = event.tokens_in_cached + event.tokens_in_cache_write;
```

### JSON Consumers

v2 serialized JSON includes the new fields:

```json
{
  "schema_version": 2,
  "actual_cost_cents": 41,
  "tokens_in_cache_write": 800,
  ...
}
```

**Backward compatibility:** If `actual_cost_cents` is missing, treat as `null`. If `tokens_in_cache_write` is missing, treat as `0`.

---

## Rollback Plan

v2 is **backward-compatible** with v1 consumers. If you need to roll back:

1. Set `TOKEN_USAGE_SCHEMA_VERSION` back to `1` in `mod.rs`
2. New events will not write `actual_cost_cents` or `tokens_in_cache_write`
3. Existing data in SQLite retains the columns (harmless)
4. Consumers that check `schema_version` will see `1` and skip the new fields

**No data migration or dump/restore required.**

---

## Future Versions

### Versioning Policy

1. **Additive only:** New fields are added as `Option<T>` or with sensible defaults. Never remove or rename existing fields within a major version.
2. **Bump `schema_version` on breaking changes:** If a field's type or semantics change, bump `schema_version`.
3. **Idempotent migrations:** SQLite migrations must be safe to run multiple times.
4. **Consumer responsibility:** Every consumer must check `schema_version` and fail gracefully on unknown versions.

### Version History

| Version | Date | Changes |
|---------|------|---------|
| 1 | 2025-Q1 | Initial schema |
| 2 | 2026-04 | Added `actual_cost_cents`, `tokens_in_cache_write` |

---

## Testing the Migration

Run the included test to verify v1 → v2 migration preserves data:

```bash
cd src-tauri
cargo test test_schema_v2_migration_preserves_data -- --nocapture
```

This test:
1. Creates v1 events
2. Applies the migration
3. Verifies old data is readable
4. Verifies new fields default correctly
