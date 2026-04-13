<p align="center">
  <img src="Aelvyril.jpeg" alt="Aelvyril" width="600"/>
</p>

<h1 align="center">Aelvyril</h1>

<p align="center">
  A local-first privacy gateway for AI workflows — intercepts accidental sensitive data leaks, pseudonymizes them, and rehydrates responses transparently.
</p>

---

## Overview

Aelvyril is a local-first privacy desktop app for AI tools and coding agents that sits between user apps and external model providers, acting as a safety net for accidental sensitive data leaks before they ever reach the cloud.

## What It Does

Aelvyril runs as a desktop app in the background and exposes its own local API endpoint and a gateway-issued API key. Users plug that key into coding agents, editors, or other AI clients instead of using upstream provider keys directly. Aelvyril then authenticates the request, inspects the content, pseudonymizes sensitive data, and forwards only the sanitized version to the real upstream provider. It also intercepts copy-paste events at the clipboard level and through a companion browser extension, catching accidental leaks at the moment sensitive content enters the workflow — before it even becomes part of a prompt.

## The Problem It Solves

Developers and teams using cloud AI tools regularly paste code, config files, logs, and emails into prompts without scanning what's in them. Aelvyril is not a strict DLP or compliance enforcement tool — it is a **safety net for accidental leaks**. Someone pastes a `.env` file into Cursor without thinking. A developer copies a snippet with a real API key still in it. A teammate shares a log with customer data in it. Aelvyril quietly catches those moments before they matter.

## Privacy and Pseudonymization Layer

The gateway intercepts prompts and detects sensitive content using **Microsoft Presidio** for structured PII combined with a local **LFM2.5-350M** model for contextual and semantic sensitivity that pattern matching alone would miss. The local model is small enough to run on CPU without a GPU, adding minimal latency. Detected entities are replaced with typed, numbered tokens before the request leaves the machine:

```
Jason Smith      → [Person_1]
SK-124124        → [SK_API_Key_1]
192.168.1.1      → [IP_Address_1]
acme-corp.com    → [Domain_1]
```

The upstream LLM receives a coherent, context-rich prompt with no real sensitive data in it.

## Rehydration

The gateway maintains a session-level mapping table tracking every token and its original value. When the upstream response returns, Aelvyril's rehydration layer scans the output, replaces all tokens with their originals, and delivers the fully restored response back to the client. The whole process is transparent to the user.

## Secure Key Storage

Users enter their upstream provider API keys — OpenAI, Anthropic, or any OpenAI-compatible endpoint — once during setup. Aelvyril stores them in the OS native keychain:

- **macOS** → Keychain
- **Windows** → Windows Credential Manager
- **Linux** → libsecret

Keys are never written to disk, never logged, and never included in audit trails. On each request Aelvyril retrieves the key from the keychain, uses it in memory, and discards it. The gateway-issued local key that users put into Cursor or other clients is also stored in the keychain and kept fully separate from upstream credentials — so even if the local key is exposed, real provider keys remain protected.

## Flow

```
Copy-paste event or prompt submission
        ↓
Aelvyril Gateway — auth, inspect, pseudonymize
        ↓
Presidio — structured PII detection
        ↓
LFM2.5-350M (local) — contextual sensitivity pass
        ↓
Sanitized prompt with typed tokens
        ↓
Upstream provider (any OpenAI-compatible endpoint)
        ↓
Response rehydrated — tokens replaced with real values
        ↓
Clean response back to client
```

## Deployment

Aelvyril ships as a native desktop app built with **Tauri**, running as a background service on macOS, Windows, and Linux. No Docker, no CLI setup, no port configuration. A companion browser extension handles copy-paste interception in web-based AI tools. The desktop app provides a settings UI for managing upstream providers, reviewing flagged content, and inspecting audit logs.

---

*In one line: Aelvyril is a local desktop privacy gateway for AI workflows that intercepts accidental sensitive data leaks at the clipboard and prompt level, pseudonymizes them with typed tokens, proxies sanitized requests to any upstream LLM provider through secure OS keychain-backed credentials, and rehydrates responses transparently.*
