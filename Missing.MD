# Aelvyril — What's Missing

_Last reviewed: 2026-04-19_

---

## What's Built Today

| Module | Status |
|---|---|
| Gateway server (Axum, OpenAI-compatible) | ✅ Done |
| Provider management (add/remove/list, multi-provider) | ✅ Done |
| PII detection engine (custom recognizers + Presidio optional) | ✅ Done |
| PII pseudonymization + rehydration roundtrip | ✅ Done |
| Allow/deny list system | ✅ Done |
| Gateway key auth (Bearer token) | ✅ Done |
| Rate limiting (per-client, minute/hour windows, concurrent slots) | ✅ Done |
| TLS support | ✅ Done |
| Session management | ✅ Done |
| Audit logging (store + export + stats) | ✅ Done |
| Token usage tracking (per-session, per-model, per-tool, pricing) | ✅ Done |
| PII detection caching (SHA-256 keyed, TTL) | ✅ Done |
| Latency benchmarking | ✅ Done |
| Streaming support with rehydration | ✅ Done |
| Provider failover | ✅ Done |
| Clipboard monitoring | ✅ Done |
| Onboarding flow | ✅ Done |
| Desktop UI (Tauri + React, settings, sidebar) | ✅ Done |
| Keychain integration (OS keychain for API keys) | ✅ Done |
| Contextual sensitivity classifier (keyword + statistical + pattern features) | ✅ Done |
| Key lifecycle auditing | ✅ Done |
| ~60+ unit tests across all modules | ✅ Done |

---

## What's Missing

### P0 — Must Have Before Anyone Sees It

| Gap | Why it matters | Effort |
|---|---|---|
| **Zero-friction setup wizard** | Right now a user needs to: install the app, open it, configure providers, paste API keys, set gateway port, enable PII. If this isn't a 2-minute guided flow, people bounce. The onboarding exists but needs to feel magical — auto-detect API keys from env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`), pre-suggest settings. | 2-3 weeks |
| **"See it work" demo** | A user installs Aelvyril and... what? They need to immediately see PII being scrubbed in real-time. A built-in demo/test page where they type "My SSN is 123-45-6789" and see it become `[SSN_REDACTED]` before their eyes. No setup required. This is the "aha moment." | 1 week |
| **Error states that don't confuse** | If Presidio isn't installed, if the gateway port is taken, if an API key is invalid — every error needs to tell the user exactly what to do. Not a Rust panic trace. Currently: partial. | 1-2 weeks |

### P1 — Must Have Before v1 Launch

| Gap | Why it matters | Effort |
|---|---|---|
| **The Orchestrator** | This is your second killer feature after PII. "Code with privacy" — a plan-and-execute agent that scrubs everything. Without this, you're just a proxy with PII, and people will ask "why not just use my editor directly?" See `ORCHESTRATOR_PLAN.md`. | 6-8 weeks |
| **PII accuracy benchmarking** | You need numbers. "We detect 99.2% of SSNs, 98.7% of emails, 97.1% of phone numbers" — with a test suite of ~1000 real-world samples. Without this, it's just claims. Trust requires proof. | 2 weeks |
| **Presidio as a bundled dependency** | Today: user needs Python + pip install presidio. That's a non-starter for most people. Bundle it (embedded Python, Docker sidecar, or port to pure Rust/WASM). The Python subprocess requirement is the biggest setup friction point. | 3-4 weeks |
| **App-level error recovery** | If the gateway crashes, the subprocess dies, or Presidio hangs — the app needs to auto-restart, auto-reconnect, and never leave the user in a broken state. Currently: the gateway starts in `setup()`, but there's no watchdog. | 1 week |

### P2 — Should Have for a Polished Product

| Gap | Why it matters | Effort |
|---|---|---|
| **Real-time dashboard** | Show live traffic: requests flowing through, PII being scrubbed, token costs ticking up. Your audit store has all the data — it just needs a live-updating UI, not just history views. | 2-3 weeks |
| **Notifications/alerts** | "You've spent $47 today" / "PII leak detected: SSN not caught" / "Provider rate limited" — push notifications via the Tauri plugin you already have. | 1 week |
| **Config profiles** | "Work profile" (strict PII, audit everything) vs "personal profile" (relaxed). People use different models and different privacy levels for different contexts. | 1 week |
| **Dark/light theme** | It's a desktop app. People will judge it. The CSS module structure is there, just needs the theming. | 1 week |

### P3 — Nice to Have, Not Blocking

| Gap | Why it matters | Effort |
|---|---|---|
| **Smart model routing** (vLLM SR discussion) | Useful for power users with 5+ providers. Most users have 2. | Deferred |
| **Semantic caching** | Save tokens on repeated queries. Nice optimization, not critical. | Deferred |
| **Jailbreak detection** | Security layer. Matters more for team/org deployment. | Deferred |
| **Hallucination detection** | Interesting but orthogonal to your core value prop. | Deferred |
| **Multi-user / team mode** | Completely different product. Don't go here yet. | Deferred |

---

## The Real Problem

**You have no marketing problem. You have a trust problem.**

The #1 thing people will think when they see Aelvyril:

> "How do I know your PII detection actually works? Prove it."

Everything else is secondary. Invest in:

1. **A public benchmark with real numbers**
2. **A demo that shows scrubbing in real-time**
3. **Clear audit logs showing exactly what was caught and what wasn't**

If those three things are solid, people will use it. If they're not, no amount of features will help.

---

## vLLM Semantic Router — Decision

**Not needed for v1.** vLLM SR is a model-selection router for server-side multi-model fleets. Aelvyril's users have 2-3 providers and pick manually. Adding SR would cost 100-200MB RAM, add config complexity, and solve a problem nobody has yet.

**When to reconsider:** If users start asking "can you auto-pick the cheapest model for this request?" or Aelvyril expands to team/org deployments with 10+ model endpoints. Then integrate as a sidecar behind a `ModelRouter` trait — see the design in the conversation history.

**The only integration that matters right now is the Orchestrator (pi RPC).** That's what makes Aelvyril a "code with privacy" product instead of a "proxy with PII."
