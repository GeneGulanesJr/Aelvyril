# Changelog

## 2026-04-23
- Refreshed `landing/index.html` copy to keep a serious tone while preserving mythic styling (more literal CTAs and demo labels; removed “Oracle” / “Enter the Gateway” phrasing).
- Fixed landing page keyboard snap controls so fullpage shortcuts no longer override focused interactive controls (for example buttons/links).
- Fixed landing page wheel snapping to allow scrolling inside nested overflow containers before advancing fullpage sections.
- Reduced landing page idle CPU/battery overhead by removing the always-on RAF watcher from global background parallax updates.
- Replaced footer placeholder legal links with real public pages and added `landing/privacy.html` and `landing/terms.html`.
- Removed the Page 2 (`.pipeline-page`) max-height cap and made it full-height to eliminate the remaining bottom band/gap artifact during section transitions.
- Fixed intermittent horizontal “gap strip” during section scrolling by increasing global background pan overscan and reducing pan range so vertical parallax never outruns its coverage.
- Refined edge fog from “rail” styling to volumetric cloud wisps (wider soft blobs, no hard side mask/border look) and retuned drift to feel more like smoke.
- Smoothed fullpage section transitions by refining the scroll animator (cubic easing, exact target snap, and queued scroll intent handling) to remove perceived gaps during up/down navigation.
- Added CSS keyframe-driven side fog drift as the default animation path so edge fog always animates even if Anime.js enhancements do not run.
- Reworked side shimmer into clearly visible ethereal side fog wisps with Anime.js drift/pulse animation, plus improved mask compatibility (`-webkit-mask-image`) and stronger blending.
- Added subtle side “ethereal shimmer” rails on the landing page using Anime.js-driven strand motion for ambient edge glow, with reduced-motion and mobile-safe behavior.
- Polished Page 2 (`#pipeline`) with improved hierarchy and readability: added a concise section subtitle, refined scene/control typography, and tuned stage panel/message card spacing for a clearer demo pass.
- Polished Page 3 (`#features`) with stronger visual hierarchy and readability: improved section subtitle clarity, added card treatment to pillar/privacy/download groups, and tightened typography/spacing for feature content.
- Polished landing Page 1 hero: tightened headline copy, strengthened left-side readability veil, reduced secondary CTA emphasis, added trust-proof chips, and softened pointer parallax intensity.
- Fixed static global background behavior by removing a reduced-motion CSS override that forced the parallax image transform to `none !important`.
- Added “zoomed camera pan” global background behavior: the fixed art layer is slightly zoomed in to create extra vertical room, then panned top→bottom based on scroll position.
- Switched the global landing parallax from `background-position` panning to a true fixed-image plane translation so the top-to-bottom scroll movement is visibly apparent on all aspect ratios.
- Implemented a single-page vertical parallax background using `landing/HeroBackground.png` (one fixed image panned through on scroll) instead of re-stacking the PNG per section.
- Updated the landing background rendering to preserve the full vertical composition of `landing/HeroBackground.png` (no “cover” cropping) and adjusted parallax scaling to avoid re-cropping via transforms.
- Extended `landing/HeroBackground.png` as a subtle, readability-safe background layer into the pipeline and features sections so the scenic art carries through the whole landing page (not just the hero).
- Corrected `landing/HeroBackground.png` implementation in `landing/index.html` by removing duplicate body-level image stacking and tuning hero-only overlays/positioning to better match the `LandingPageTemplate.png` composition.
- Refined the pipeline demo implementation in `landing/index.html` to prevent text context clipping by increasing demo card height, improving bubble wrapping, and showing prior turns in a muted state instead of hard-hiding already streamed context.
- Overhauled the `landing/index.html` pipeline demo transfer visuals by adding animated packet badges and directional track sweeps so prompt/reply movement is clearly visible across stages.
- Fixed pipeline chapter highlighting logic by aligning narration chapter keys with UI chapter IDs (`ward`, `cipher`, `transit`, `recall`) so active-step indicators now sync with playback.
- Restyled `landing/index.html` to match the visual tone of `landing/LandingPageTemplate.jpg` while preserving existing content and section arrangement.
- Set `landing/HeroBackground.png` as the hero/background art using layered overlays for a softer fantasy look and stronger readability.
- Added a new pointer-based parallax pass on hero layers and hero content (Fireship-style depth logic) with anime.js entry animation and reduced-motion fallback.
- Tuned glass panels, overlays, and download/feature surfaces across the landing sections to align with the new art direction.
- Reduced the visual scale of the pipeline “demo” (panels, type, spacing, tracks) so it reads as an embedded demo instead of dominating the viewport.
- Upgraded the pipeline demo to a cinematic anime.js sequence with stage spotlighting, scene labels, control buttons (pause/replay), energy burst accents, and token/rehydration pulse effects.
- Hid demo scrollbars (while keeping internal scrolling) and reduced demo height further to avoid viewport domination.
- Added an animated glowing “energy ring” border around the demo that shifts color with the current demo phase.
- Scoped the glowing moving border to only the currently active stage panel to make the animation focus clearer.
- Changed the stage glow ring into a clearer “loading sweep” (bright moving arc + trailing glow) so the motion reads as progress around the panel.
- Increased stage-ring visibility (thicker/high-contrast sweep) and suppressed focused panel borders to remove the double-border appearance.
- Fixed stage-ring layering so the animated border no longer overlays panel text content.
- Trimmed leading/trailing whitespace during demo text tokenization to remove phantom blank gaps under panel labels.
- Added synchronized on-screen storytelling for the demo (chapter chips + narration lines) to improve dramatic presentation before audio voiceover is added.
- Updated demo storytelling flow to start in stage-by-stage spotlight mode and reveal the full system together as the end-of-loop payoff.
- Reduced demo card height and panel padding so stage cards feel appropriately sized even when only short narration/text is visible.
- Restyled per-turn demo content into compact chat-style bubbles (left/right aligned by turn) to better match a small chatbox presentation.
- Stage-by-stage mode now shows a single “live turn” card per panel, with the full turn history revealed only at finale to avoid early clipping/crowding.

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
