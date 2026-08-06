# Aelvyril Documentation

This is the documentation index for the [Aelvyril](../README.md) repository — a
local desktop privacy gateway for AI workflows.

## Repository layout

| Path | Contents |
|------|----------|
| `src-tauri/` | Rust backend (Tauri v2): gateway HTTP server, PII detection, pseudonymization, keychain, audit log, session manager, token-usage tracking, onboarding |
| `src/` | React + TypeScript frontend (Vite): Dashboard, Audit Log, Sessions, Settings, Security, Onboarding pages |
| `docs/superpowers/plans/` | Active/recent design plans |
| `docs/superpowers/plans/archive/` | Historical plans (removed features, superseded designs) — kept for reference |
| `.kilo/plans/` | Captured plan history (do not edit) |

## Key source locations

- **Token usage schema & tracking:** `src-tauri/src/token_usage/`
- **Token usage Tauri commands:** `src-tauri/src/commands/token_usage.rs`
- **Frontend dashboard:** `src/pages/Dashboard.tsx`

For product overview and getting started, see the top-level
[`README.md`](../README.md).
