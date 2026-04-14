<p align="center">
  <img src="Aelvyril.jpeg" alt="Aelvyril" width="600"/>
</p>

<h1 align="center">Aelvyril</h1>

<p align="center">
  A local desktop privacy gateway for AI workflows — automatically intercepts and pseudonymizes accidental sensitive data leaks at the clipboard and prompt level, routes sanitized requests to any upstream LLM provider through secure OS keychain-backed credentials, and rehydrates responses transparently.
</p>

---

## Overview

Aelvyril is a local-first privacy desktop app for AI tools and coding agents that sits between user apps and external model providers, acting as a safety net for accidental sensitive data leaks before they ever reach the cloud.

## What It Does

Aelvyril runs as a desktop app in the background and exposes its own local API endpoint and a gateway-issued API key. Users plug that key into coding agents, editors, or other AI clients instead of using upstream provider keys directly. Aelvyril authenticates the request, inspects the content, automatically pseudonymizes any detected sensitive data, and forwards only the sanitized version to the real upstream provider. It also intercepts copy-paste events at the clipboard level and through a companion browser extension, catching accidental leaks at the moment sensitive content enters the workflow — before it even becomes part of a prompt.

## The Problem It Solves

Developers and teams using cloud AI tools regularly paste code, config files, logs, and emails into prompts without scanning what's in them. Aelvyril is not a strict DLP or compliance enforcement tool — it is a **safety net for accidental leaks**. Someone pastes a `.env` file into Cursor without thinking. A developer copies a snippet with a real API key still in it. A teammate shares a log with customer data in it. Aelvyril quietly catches those moments before they matter.

## Privacy and Pseudonymization Layer

The gateway intercepts prompts and detects sensitive content using native Rust PII recognizers (reimplemented from Microsoft Presidio's structured patterns) combined with a local **LFM2.5-350M** model for contextual and semantic sensitivity that pattern matching alone would miss. The local model is small enough to run on CPU without a GPU, adding minimal latency. Detection and sanitization happen automatically with no interruption to the user's workflow. Detected entities are replaced with typed, numbered tokens before the request leaves the machine:

```
Jason Smith      → [Person_1]
SK-124124        → [SK_API_Key_1]
192.168.1.1      → [IP_Address_1]
acme-corp.com    → [Domain_1]
```

The upstream LLM receives a coherent, context-rich prompt with no real sensitive data in it.

## Rehydration

The gateway maintains a session-level mapping table tracking every token and its original value. When the upstream response returns, Aelvyril's rehydration layer scans the output, replaces all tokens with their originals, and delivers the fully restored response back to the client. The whole process is transparent to the user.

## Session Management

Sessions are tied to the conversation context of the client tool — a new chat in Cursor starts a fresh session with a clean mapping table. Aelvyril also applies a configurable inactivity timeout, defaulting to 30 minutes, after which the session resets. Users can view all active sessions and manually clear them from the desktop app at any time.

## Audit Log

Every request passing through Aelvyril is logged locally. The audit log captures what was detected, what type of entity it was, what token it was mapped to, which upstream provider received the sanitized request, and when it happened. The log never stores the original sensitive values — only the token types and metadata. Users can review their audit log from the desktop app and see a running history of what Aelvyril has caught and sanitized on their behalf.

## Allow and Deny Lists

Users can configure custom rules in settings using regex patterns. An **allowlist** tells Aelvyril to never flag certain patterns — useful for internal codenames, company domains, or tokens that get falsely detected. A **denylist** adds custom patterns on top of what the built-in recognizers and local model already catch, so teams can enforce project-specific rules. Both lists are managed from the settings UI without any code changes.

## Secure Key Storage

Users enter their upstream provider API keys once during setup. Aelvyril stores them in the OS native keychain:

- **macOS** → Keychain
- **Windows** → Windows Credential Manager
- **Linux** → libsecret

Keys are never written to disk, never logged, and never included in audit trails. On each request Aelvyril retrieves the key from the keychain, uses it in memory, and discards it. The gateway-issued local key that users put into Cursor or other clients is also stored in the keychain and kept fully separate from upstream credentials.

## Multi-Provider Support and Routing

Users can add as many upstream providers as they want — OpenAI, Anthropic, or any OpenAI-compatible endpoint. Aelvyril handles routing automatically based on the model name in the request. If a request comes in for `gpt-4o`, it routes to OpenAI. If it comes in for `claude-sonnet`, it routes to Anthropic. The user just picks their model in their tool as usual and Aelvyril figures out where to send it. If a provider fails, Aelvyril falls back to the next available provider automatically.

## Onboarding

Setup is three steps:

1. **Add your first upstream provider** and paste your API key into Aelvyril
2. **Copy the Aelvyril-issued local key** and paste it into your tool
3. **Optionally install the companion browser extension** for web-based AI tools

Aelvyril auto-detects common tools like Cursor and shows setup instructions specific to them, so users know exactly where to paste the key without having to figure it out themselves.

## Deployment

Aelvyril ships as a native desktop app built with **Tauri**, running as a background service on macOS, Windows, and Linux. No Docker, no CLI setup, no port configuration. A companion browser extension handles copy-paste interception in web-based AI tools. The desktop app provides a settings UI for managing upstream providers, configuring allow and deny lists, reviewing the audit log, and managing active sessions.

## Flow

```
Copy-paste event or prompt submission
        ↓
Aelvyril Gateway — auth, inspect, pseudonymize
        ↓
Native PII recognizers — structured PII detection (Rust reimplementation of Presidio)
        ↓
LFM2.5-350M (local, ONNX/CPU) — contextual sensitivity pass
        ↓
Sanitized prompt with typed tokens
        ↓
Upstream provider (routed automatically by model name, with fallback)
        ↓
Response rehydrated — tokens replaced with real values
        ↓
Clean response back to client
```

---

*In one line: Aelvyril is a local desktop privacy gateway for AI workflows that automatically intercepts and pseudonymizes accidental sensitive data leaks at the clipboard and prompt level, routes sanitized requests to any upstream LLM provider through secure OS keychain-backed credentials, and rehydrates responses transparently — so developers can use cloud AI tools without worrying about what they paste.*
