# Token Usage Statistics — Privacy Disclosure

**Document version:** 1.0  
**Last updated:** 2026-04-23  
**Applies to:** Aelvyril v0.x (token usage tracking module)

---

## What We Collect

Token usage statistics are **aggregate counts only**. For every LLM call that passes through Aelvyril, we record:

| Field | Example | Purpose |
|-------|---------|---------|
| `session_id` | `sess_7a3f...` (UUID) | Group calls into sessions |
| `tool_name` | `chat_completions`, `passthrough` | Identify which feature triggered the call |
| `model_id` | `gpt-4o`, `claude-3-opus` | Track per-model costs |
| `tokens_in_system` | 1,200 | System prompt overhead (fixed cost) |
| `tokens_in_user` | 8,500 | User/context tokens sent |
| `tokens_in_cached` | 3,400 | Cached prompt tokens (discounted rate) |
| `tokens_in_cache_write` | 800 | Cache-write tokens (premium rate) |
| `tokens_out` | 2,100 | Completion tokens generated |
| `tokens_truncated` | 150 | Tokens lost to context overflow |
| `cost_estimate_cents` | 42 | Estimated cost in integer cents |
| `actual_cost_cents` | `null` or 41 | Provider-reported cost when available |
| `duration_ms` | 1,340 | Wall-clock latency |
| `success` | `true`/`false` | Whether the call completed |
| `retry_attempt` | 0, 1, 2... | Retry tracking |
| `timestamp` | 2026-04-23T14:30:00Z | Server-side time (rounded to minute) |

**All counts are numbers. No text, no prompts, no responses.**

---

## What We Do NOT Collect

The following are **never** stored in token usage statistics:

- ❌ User messages or prompts
- ❌ Model responses or completions
- ❌ File contents
- ❌ Query text
- ❌ Search keywords
- ❌ Conversation history
- ❌ Any personally identifiable information (PII)

> **Important:** Raw LLM content is sent to third-party model providers (OpenAI, Google, Anthropic, etc.) under their own data policies. Aelvyril's token stats are separate from that pipeline.

---

## Inference Risks We Mitigate

Even aggregate counts can leak information in theory. We address these risks:

### Tool-Name Fingerprinting
`tool_name` + `tokens_in` can reveal activity patterns (e.g., `search_columns` with 12k tokens suggests database exploration). **Mitigation:** At lower authorization levels, tool names are redacted to generic categories (`"llm_call"`). API responses include `meta.access_level` so you know what detail you're seeing.

### Intersection Attacks
Querying stats at two timepoints and diffing them could infer what happened in between. **Mitigation:**
- Stats API is rate-limited (default: 120/min, 5000/hour per command)
- Timestamps are rounded to the nearest minute (not millisecond)
- Event-level data is batched before persistence

### Session Enumeration
If `session_id` were sequential, an attacker could enumerate all sessions. **Mitigation:** Session IDs are UUID v4 (opaque, non-sequential, 122 bits of randomness).

---

## Retention & Erasure

| Data type | Retention | Auto-purge |
|-----------|-----------|------------|
| Event-level records | 30 days | ✅ Yes |
| Daily aggregates (L3) | Indefinite | ❌ No |
| Session totals (L1) | Indefinite | ❌ No |

**Right to delete:** You can request deletion of all token stats associated with a `session_id` via the admin API. This applies to event-level data only; aggregated daily trends cannot be un-rolled.

**Data export:** Token stats for a session can be exported as JSON for portability.

---

## Access Control

| Level | What you see | Who |
|-------|-------------|-----|
| `full` | All fields, per-tool detail, per-model detail | Admin |
| `summary` | Aggregated totals only, no per-call detail | Standard user |
| `redacted` | Tool names generalized, no cost detail | External / public |

The `meta.access_level` field in every API response tells you which level you're receiving.

---

## Cost Alert Thresholds

Aggregate cost monitoring runs locally to detect potential abuse or budgeting issues. Thresholds are **configurable** and stored in your local settings.

| Threshold | Default | Purpose |
|------------|---------|---------|
| `runaway_session_cents` | 500¢ ($5.00) | Flag a session whose total cost exceeds this |
| `cost_spike_multiplier` | 5.0× | Flag if a single call costs >5× the session average |
| `abnormal_retry_rate` | 0.30 (30%) | Flag if >30% of calls in a session are retries |
| `daily_cost_spike_cents` | 1000¢ ($10.00) | Flag if daily spend exceeds this multiple times |

Thresholds are evaluated **client-side only**; no threshold data leaves your machine. You can adjust these values in Settings → Token Usage → Alert Thresholds.

---

## Legal Basis

Token usage statistics are collected under **legitimate interest** (GDPR Article 6(1)(f)) for the purpose of:
- Cost monitoring and budgeting
- System performance optimization
- Abuse detection (runaway sessions, anomalous retry rates)

Statistics are not used for profiling, advertising, or cross-service tracking.

---

## Questions?

If you have concerns about what is being collected, inspect the source:
- Data model: `src-tauri/src/token_usage/mod.rs`
- Event emission: `src-tauri/src/token_usage/tracker.rs`
- Store schema: `src-tauri/src/token_usage/store.rs`

All fields are visible in code. There are no hidden telemetry channels.
