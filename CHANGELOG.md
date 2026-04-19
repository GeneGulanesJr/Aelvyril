# Changelog

## 2026-04-15
- Added persisted `AppSettings` storage (`settings.json`) and load-on-start behavior for Tauri state.
- Made gateway rate limits configurable via settings (applied live to the `RateLimiter`) and exposed settings-backed `get_rate_limit_status`.
- Enriched `get_gateway_status` with `bind_address`, `url`, and `health_endpoint` for UI/diagnostics.
- Fixed `AuditEntryCard` CSS import to resolve `AuditLog.module.css` from `src/pages/` (Vite could not resolve the previous same-directory path).
- Fixed `SessionCard` CSS import to use `src/pages/Sessions.module.css` instead of a missing `components`-local path.
- Fixed `EntityBreakdown`, `GatewayInfo`, and `StatCard` imports to resolve `Dashboard.module.css` from `src/pages/`.
- Fixed Rust list-rule commands by normalizing `pattern` to `String`, avoiding `&str`/`String` conditional type mismatches.
- Tightened dashboard and animation typings: generic `useAnimatedValues`, null-safe interpolation, and `LucideIcon`-typed stat cards/sessions to eliminate TS type errors.
- Removed unused `compile_regex` helper in `src-tauri/src/pii/recognizers.rs` to eliminate a dead-code warning.
- Gateway `router`: map missing keychain entries to `RouterError::NoApiKey`, use `build_passthrough_url` for `/v1/*` passthrough, fix passthrough path joining, drop unused `UpstreamError` / `provider_name_for_model`, add passthrough URL unit test.
- Refactored `src-tauri/src/lib.rs` into focused modules (`state`, `bootstrap`, `commands`, and helper modules under `pii`, `providers`, and `onboarding`) to reduce file size and improve maintainability.
- Refactored Linux clipboard reading, pseudonymization token replacement, and `Sidebar` rendering to reduce cyclomatic complexity and nesting (no functional changes).

## 2026-04-14
- Expanded `design.md` into a production-ready design spec by adding semantic color/state tokens, typography scale, layout/spacing system, component guidance, and accessibility requirements.
- Synced `plan.md` Shot 1 checklist to current implementation status (checked completed scaffolding, gateway, keychain, PII, pseudonymization, and sessions; left local ONNX model + streaming rehydration/failover unchecked).
