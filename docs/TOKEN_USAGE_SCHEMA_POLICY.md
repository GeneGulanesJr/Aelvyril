# Token Usage Schema Evolution Policy

**Document version:** 1.0  
**Last updated:** 2026-04-23  
**Current schema version:** 2

---

## Principles

1. **Additive only.** New fields are added as `Option<T>` or with sensible defaults. Existing fields are never removed or renamed within a major version.
2. **Schema version bump on breaking changes.** If a field's type or semantics change, `schema_version` must be incremented.
3. **Idempotent migrations.** SQLite migrations must be safe to run multiple times.
4. **Consumer responsibility.** Every consumer must check `schema_version` and fail gracefully on unknown versions.
5. **Document everything.** Every schema change requires an update to `TOKEN_USAGE_FIELD_REFERENCE.md` and `TOKEN_USAGE_MIGRATION_GUIDE.md`.

---

## Versioning Rules

### When to Bump `schema_version`

Bump the version when ANY of the following occur:

- A field is removed
- A field is renamed
- A field's type changes (e.g., `u64` → `i64`)
- A field's semantics change (e.g., `tokens_in_cached` no longer includes cache-write tokens)
- A required field is added that has no sensible default

Do NOT bump the version when:

- An optional field is added with a default value
- A new enum variant is added
- Documentation improves
- A new index is added to the SQLite store

### Version Numbering

- Use simple integers: `1`, `2`, `3`...
- No minor/patch versions — every bump is potentially breaking
- The constant `TOKEN_USAGE_SCHEMA_VERSION` in `mod.rs` is the single source of truth

---

## Migration Procedures

### For Rust Code Changes

1. Add the new field to `TokenUsageEvent` (or relevant struct)
2. Set a sensible default in event constructors
3. Update `make_event()` in `tracker.rs`
4. Update `to_stats()` in `tracker.rs` if the field affects aggregation
5. Update SQLite `store.rs` with an idempotent `ALTER TABLE`
6. Bump `TOKEN_USAGE_SCHEMA_VERSION`
7. Write a migration test
8. Update documentation

### For SQLite Schema Changes

```rust
// Idempotent migration pattern
let cols: Vec<String> = conn
    .prepare("PRAGMA table_info(token_usage_events)")?
    .query_map([], |row| row.get::<_, String>(1))?
    .collect::<Result<Vec<_>, _>>()?;

if !cols.contains("new_field") {
    conn.execute(
        "ALTER TABLE token_usage_events ADD COLUMN new_field INTEGER NOT NULL DEFAULT 0",
        [],
    )?;
}
```

### For Consumer-Facing API Changes

1. Add the new field to `TokenStatsResponse`
2. Ensure JSON serialization includes the new field
3. Update frontend types if applicable
4. Document the field in `TOKEN_USAGE_FIELD_REFERENCE.md`

---

## Consumer Contract

Every consumer of token usage data must:

1. **Check `schema_version`** before parsing
2. **Fail gracefully** on unknown versions (log warning, skip unknown fields)
3. **Use `Option` fields safely** — assume any field may be missing
4. **Handle defaults** — missing fields should use documented defaults

### Example (Rust)

```rust
if stats.schema_version > TOKEN_USAGE_SCHEMA_VERSION {
    tracing::warn!("Received token stats with unsupported schema version {} (expected {})",
        stats.schema_version, TOKEN_USAGE_SCHEMA_VERSION);
    // Use default values for unknown fields
}
```

### Example (JSON Consumer)

```javascript
const actualCost = data.actual_cost_cents ?? data.cost_estimate_cents;
const cacheWrite = data.tokens_in_cache_write ?? 0;
```

---

## Rollback Policy

Schema changes are designed to be **backward-compatible**:

- New fields have defaults
- Old consumers ignore unknown fields
- SQLite columns are nullable or have defaults

If a schema change causes issues:

1. Revert the code change
2. Keep the SQLite columns (they are harmless)
3. New events will not write the reverted fields
4. Existing data remains readable

**No data migration or dump/restore is required for rollback.**

---

## Change Log

| Date | Schema Version | Change | Author |
|------|---------------|--------|--------|
| 2025-Q1 | 1 | Initial schema | Engineering |
| 2026-04-23 | 2 | Added `actual_cost_cents`, `tokens_in_cache_write` | Engineering |

---

## Review Checklist

Before merging any schema change:

- [ ] Field added with sensible default
- [ ] SQLite migration is idempotent
- [ ] `TOKEN_USAGE_SCHEMA_VERSION` bumped (if breaking)
- [ ] Migration test written
- [ ] `TOKEN_USAGE_FIELD_REFERENCE.md` updated
- [ ] `TOKEN_USAGE_MIGRATION_GUIDE.md` updated
- [ ] Frontend types updated (if applicable)
- [ ] Rollback plan documented
