# Changelog

## 2026-04-15
- Fixed `AuditEntryCard` CSS import to resolve `AuditLog.module.css` from `src/pages/` (Vite could not resolve the previous same-directory path).
- Fixed `SessionCard` CSS import to use `src/pages/Sessions.module.css` instead of a missing `components`-local path.
- Fixed `EntityBreakdown`, `GatewayInfo`, and `StatCard` imports to resolve `Dashboard.module.css` from `src/pages/`.
- Gateway `router`: map missing keychain entries to `RouterError::NoApiKey`, use `build_passthrough_url` for `/v1/*` passthrough, fix passthrough path joining, drop unused `UpstreamError` / `provider_name_for_model`, add passthrough URL unit test.

## 2026-04-14
- Expanded `design.md` into a production-ready design spec by adding semantic color/state tokens, typography scale, layout/spacing system, component guidance, and accessibility requirements.
- Synced `plan.md` Shot 1 checklist to current implementation status (checked completed scaffolding, gateway, keychain, PII, pseudonymization, and sessions; left local ONNX model + streaming rehydration/failover unchecked).
