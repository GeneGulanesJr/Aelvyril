# Aelvyril Documentation

## Token Usage Statistics

| Document | Audience | Purpose |
|----------|----------|---------|
| [`TOKEN_USAGE_USER_GUIDE.md`](TOKEN_USAGE_USER_GUIDE.md) | End users | How to read the dashboard, interpret metrics, and use features |
| [`TOKEN_USAGE_PRIVACY.md`](TOKEN_USAGE_PRIVACY.md) | End users / Legal | What is collected, what is not, inference risks, retention, and legal basis |
| [`TOKEN_USAGE_MIGRATION_GUIDE.md`](TOKEN_USAGE_MIGRATION_GUIDE.md) | Developers / Integrators | v1 → v2 schema migration: new fields, consumer changes, rollback plan |
| [`TOKEN_USAGE_SCHEMA_POLICY.md`](TOKEN_USAGE_SCHEMA_POLICY.md) | Developers | Schema versioning rules, idempotent migration patterns, consumer contract |
| [`TOKEN_USAGE_BASELINE_METHODOLOGY.md`](TOKEN_USAGE_BASELINE_METHODOLOGY.md) | Developers / Data analysts | Documented baselines for `tokens_saved` metrics, cross-model comparison rules |
| [`TOKEN_USAGE_OPERATIONS.md`](TOKEN_USAGE_OPERATIONS.md) | Engineering / SRE | Runbook: dogfooding, orphan monitoring, cost alert thresholds, incident response |
| [`TOKEN_USAGE_LEGAL_REVIEW.md`](TOKEN_USAGE_LEGAL_REVIEW.md) | Legal / Compliance | GDPR, SOC 2, and EU AI Act readiness checklist and review package |

## Quick Links

- **Schema version:** `2` (see `src-tauri/src/token_usage/mod.rs`)
- **Source code:** `src-tauri/src/token_usage/`
- **Tauri commands:** `src-tauri/src/commands/token_usage.rs`
- **Frontend dashboard:** `src/pages/Dashboard.tsx`
