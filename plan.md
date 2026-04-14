# Aelvyril — Development Plan

## Shot 1: The Pipe Works

*Goal: A working gateway — send a real request through Aelvyril to an upstream provider and get a clean, rehydrated response back. By the end of this shot the core value prop is proven.*

### 1.1 Project Scaffolding
- [ ] Initialize Tauri v2 project (Rust backend + React/TypeScript frontend)
- [ ] Set up monorepo structure: `src-tauri/`, `src/`, `extension/`
- [ ] Configure TypeScript, ESLint, Prettier, and Rust formatting
- [ ] Set up CI pipeline (GitHub Actions) — lint, build, test per platform

### 1.2 Core Gateway Server
- [ ] Build local HTTP server in Rust (axum/actix-web) running on `localhost`
- [ ] Implement gateway API key generation and storage
- [ ] Build request router that forwards to upstream OpenAI-compatible endpoints
- [ ] Implement streaming (SSE) passthrough for chat completions
- [ ] Implement multi-provider routing based on model name in the request (e.g. `gpt-4o` → OpenAI, `claude-sonnet` → Anthropic)
- [ ] Implement automatic failover to next available provider if primary fails

### 1.3 Keychain Integration
- [ ] Integrate `keyring` crate for OS-native secret storage
  - [ ] macOS — Keychain
  - [ ] Windows — Credential Manager
  - [ ] Linux — libsecret / Secret Service API
- [ ] Build key management module (store, retrieve, delete, list provider keys)
- [ ] Ensure keys are never written to disk or logged

### 1.4 Native Rust PII Detection Layer
- [ ] Re-implement Presidio's structured PII recognizers as native Rust regex patterns — no Python sidecar needed
  - Email, Phone, IP Address, Domain, API Key patterns, Credit Card, SSN, IBAN
  - Regex-based recognizers cover 90%+ of structured PII without any external dependency
- [ ] The local LFM2.5-350M model (Section 1.5) handles the contextual/semantic sensitivity pass that Presidio normally needs spaCy NER for — eliminating the only part that can't be cleanly reimplemented in pure Rust
- [ ] Build entity extraction pipeline that returns structured matches with confidence scores

### 1.5 Local Model Layer (LFM2.5-350M via ONNX)
- [ ] **Model**: [`LiquidAI/LFM2.5-350M-ONNX`](https://huggingface.co/LiquidAI/LFM2.5-350M-ONNX) on HuggingFace (official Liquid AI ONNX export)
  - Architecture: `Lfm2ForCausalLM`, 350M parameters
  - Quantization options: fp32 (1.4 GB), fp16 (725 MB), q8 (634 MB), **q4f16 (255 MB)**, q4 (294 MB)
  - **Recommended**: `model_q4f16.onnx` + `model_q4f16.onnx_data` (~255 MB) — best size-to-quality ratio for CPU inference
  - Multi-language support: en, ar, zh, fr, de, ja, ko, es, pt
- [ ] **Runtime**: [`ort`](https://crates.io/crates/ort) crate v2.0 (Rust wrapper for ONNX Runtime 1.24) — 8.3M downloads, mature, cross-platform CPU support
- [ ] Bundle the ONNX model files with the Tauri app (downloaded on first launch or included in installer)
- [ ] Build model service that accepts a prompt and returns detected sensitive spans
- [ ] Run model inference in a background thread to avoid blocking the gateway
- [ ] Tune detection thresholds to balance catch rate vs. false positives

### 1.6 Pseudonymization Engine
- [ ] Build tokenizer that replaces detected entities with typed, numbered tokens
  - `[Person_1]`, `[SK_API_Key_1]`, `[IP_Address_1]`, `[Domain_1]`, etc.
- [ ] Maintain session-level mapping table (token → original value) with TTL
- [ ] Handle edge cases: partial overlaps, nested entities, repeated values
- [ ] Serialize mapping to memory only — never to disk

### 1.7 Rehydration Layer
- [ ] Scan upstream response for any tokens present in the session mapping
- [ ] Replace tokens with original values in streaming and non-streaming modes
- [ ] Gracefully handle tokens the upstream model modifies or drops
- [ ] Deliver fully restored response to the client

### 1.8 Session Management
- [ ] Tie sessions to the conversation context of the client tool
- [ ] Each new conversation starts a fresh session with a clean mapping table
- [ ] Implement configurable inactivity timeout (default: 30 minutes) after which the session resets
- [ ] Build session storage layer — list active sessions, show metadata
- [ ] Allow users to manually clear any session at any time

---

## Shot 2: It's a Real App

*Goal: Turn the working pipe into a usable daily desktop app with clipboard interception, audit logging, allow/deny lists, settings, onboarding, and a companion browser extension.*

### 2.1 Desktop Clipboard Monitor
- [ ] Build a system-level clipboard listener in Rust (platform-specific, event-driven where possible)
  - [ ] **macOS** — `CGEventTap` to intercept copy events (requires Accessibility permission); fall back to `NSPasteboard.changeCount` polling at **250 ms** if permission denied
  - [ ] **Windows** — `AddClipboardFormatListener` (event-driven, zero CPU overhead when idle)
  - [ ] **Linux/X11** — XFixes `XFixesSelectSelectionInput` for selection change events (event-driven)
  - [ ] **Linux/Wayland** — `wl-clipboard` polling at **500 ms** (no standardized event API; Wayland compositors like KDE/GNOME have non-standard D-Bus signals but they aren't portable)
- [ ] On clipboard change, run content through PII detection + local model
- [ ] If sensitive content detected: show OS notification with option to sanitize or allow

### 2.2 Browser Extension
- [ ] Scaffold Chrome/Firefox extension (Manifest V3)
- [ ] Intercept copy-paste events in web pages (content script)
- [ ] Scan clipboard content before paste into web-based AI tools
- [ ] Communicate with the desktop app via **local WebSocket bridge** (`ws://localhost:<port>`)
  - Simpler than native messaging — no per-browser binary registration required
  - Chrome MV3: works with `host_permissions` for `localhost`
  - Firefox MV2/MV3: WebSocket supported natively in background scripts
  - Single WebSocket server on the Tauri app serves all browsers
- [ ] Show inline warning banner when sensitive content is detected

### 2.3 Audit Log
- [ ] Log every request passing through Aelvyril locally
- [ ] Capture per-request metadata: what was detected, entity type, token mapping, upstream provider, timestamp
- [ ] Never store original sensitive values in the log — only token types and metadata
- [ ] Build audit log storage layer (local SQLite or append-only file)
- [ ] Build audit log UI in the desktop app — running history of what was caught and sanitized
- [ ] Allow users to export the audit log (sanitized) as JSON/CSV
- [ ] Allow users to whitelist or adjust detection rules from the audit log view

### 2.4 Allow and Deny Lists
- [ ] Build allowlist — regex patterns to never flag (internal codenames, company domains, falsely detected tokens)
- [ ] Build denylist — custom patterns on top of built-in detection (project-specific rules)
- [ ] Store lists in local config (persisted across restarts)
- [ ] Apply lists in real-time to the detection pipeline without code changes
- [ ] Build allowlist/denylist management UI in settings

### 2.5 Settings Panel
- [ ] Provider management — add/edit/remove upstream providers with model-to-provider routing
- [ ] Gateway key display and regeneration
- [ ] Model configuration — enable/disable PII recognizers, adjust sensitivity
- [ ] Startup behavior — launch at login, system tray integration

### 2.6 Audit Dashboard & Session Viewer
- [ ] Display recent requests with timestamp, provider, and pseudonymization summary
- [ ] Show flagged entities per request (no raw values — tokens only)
- [ ] List all active sessions with creation time, last activity, and provider info
- [ ] Allow manual session clearing
- [ ] Show session timeout configuration

### 2.7 System Tray & Notifications
- [ ] System tray icon with status indicator (active/idle/error)
- [ ] Right-click menu: quick toggle, open dashboard, quit
- [ ] OS notification on sensitive content detection
- [ ] Notification action buttons: "Sanitize & Send" / "Block"

### 2.8 Onboarding Flow
- [ ] Auto-detect common tools like Cursor and show tool-specific setup instructions
- [ ] Step-by-step onboarding wizard:
  1. Add first upstream provider and paste API key
  2. Copy the Aelvyril-issued local key and paste into tool
  3. Optionally install companion browser extension
- [ ] Show clear guidance on where to paste the key for detected tools

---

## Shot 3: It Ships

*Goal: Hardening, testing, performance, and distribution — turn the usable app into a production-ready product people can install and trust.*

### 3.1 Security
- [ ] All local traffic over loopback only (no external binding)
- [ ] TLS for local endpoint (self-signed, auto-generated)
- [ ] Rate limiting on the gateway API to prevent abuse
- [ ] Audit the key lifecycle — ensure no key ever hits disk, logs, or crash dumps

### 3.2 Testing
- [ ] Unit tests for pseudonymization and rehydration logic
- [ ] Unit tests for allow/deny list matching
- [ ] Unit tests for session lifecycle and timeout behavior
- [ ] Integration tests for the full request/response pipeline
- [ ] Integration tests for multi-provider routing and failover
- [ ] Property-based fuzzing for edge cases in token mapping
- [ ] End-to-end tests against real upstream providers (opt-in, CI-keyed)

### 3.3 Performance
- [ ] Benchmark gateway latency overhead (target: <500ms added per request)
- [ ] Lazy-load the local model on first request (not at app startup)
- [ ] Cache PII recognizer results for repeated content
- [ ] Profile and optimize clipboard polling frequency

### 3.4 Distribution
- [ ] Build installers for macOS (.dmg), Windows (.msi), and Linux (.deb, .AppImage)
- [ ] Auto-update mechanism via Tauri's built-in updater
- [ ] Code-sign binaries for each platform
- [ ] Publish browser extension to Chrome Web Store and Firefox Add-ons

---

## Future Considerations

- [ ] Plugin system for additional PII recognizers
- [ ] Team mode — shared detection policies synced over a local server
- [ ] Support for non-text modalities (images, files)
- [ ] Metrics dashboard — leak prevention stats over time

---

## Architecture Decisions (Resolved)

### 1. Presidio Integration → Native Rust Regex + Local Model
**Decision**: Re-implement Presidio's structured PII recognizers as native Rust regex patterns. No Python sidecar, no WASM.
**Rationale**:
- Microsoft has not ported Presidio to WASM. No mature Rust port exists (the `pii` crate is v0.1.0 with 239 downloads).
- Presidio's core value for structured PII is regex patterns + allow/deny lists — trivially reimplementable in Rust.
- The only hard part to port is spaCy NER for contextual understanding — but the LFM2.5-350M local model already handles that semantic pass.
- Result: zero external dependencies, fully native, fast.

### 2. LFM2.5-350M Runtime → ONNX Runtime via `ort` Crate
**Decision**: Use `LiquidAI/LFM2.5-350M-ONNX` from HuggingFace with the `ort` Rust crate.
**Rationale**:
- Official Liquid AI ONNX export available with multiple quantization levels.
- `q4f16` variant at ~255 MB offers the best size-to-quality ratio for CPU-only inference.
- `ort` crate (v2.0, 8.3M downloads) is the most mature Rust ONNX Runtime wrapper, supporting all three platforms.
- ONNX Runtime is optimized for CPU (SIMD: AVX2/NEON) with consistent performance across macOS/Windows/Linux.

### 3. Browser Extension Communication → Local WebSocket Bridge
**Decision**: Run a WebSocket server on the Tauri app; the extension connects to `ws://localhost:<port>`.
**Rationale**:
- Native messaging requires per-browser manifest files and binary path registration in OS-specific locations — fragile and annoying for users.
- WebSocket to localhost is supported in Chrome MV3 (with `host_permissions`) and Firefox MV2/MV3 natively.
- One WebSocket server serves all browsers. Extension just needs to know the port.
- Much simpler installation and update experience.

### 4. Clipboard Monitoring → Event-Driven Everywhere Except Wayland
**Decision**: Use OS-native event APIs where available; polling only as fallback.
**Rationale**:
| Platform | Method | Overhead |
|----------|--------|----------|
| Windows | `AddClipboardFormatListener` — event-driven | Zero when idle |
| macOS | `CGEventTap` — event-driven (requires Accessibility permission) | Zero when idle |
| macOS fallback | `NSPasteboard.changeCount` polling | ~250 ms |
| Linux/X11 | XFixes selection events — event-driven | Zero when idle |
| Linux/Wayland | `wl-clipboard` polling | ~500 ms (only option) |

On Wayland, 500 ms polling is acceptable because clipboard changes are infrequent and the user isn't waiting on real-time interception — the safety net just needs to catch content before it reaches a prompt.
