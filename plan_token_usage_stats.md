# Plan: Token Usage Statistics (In/Out)

## Overview
Add token usage statistics (tokens in, tokens out) to the system with layered reporting, privacy safeguards, and efficiency metrics.

---

## Step 1 — Privacy ✅ VERIFY FIRST

**Goal:** Ensure no token content or personally identifiable information leaks through stats — including inference attacks on aggregate data.

### 1.1 Direct Content Leakage
- [ ] Only aggregate counts are logged — never raw content payloads
- [ ] No user input/output text is stored alongside stats
- [ ] Stats are keyed by session/tool identifiers, not by user identity (unless explicitly opted in)
- [ ] Audit data model — confirm no raw content fields exist in stats tables/objects
- [ ] Audit logging — confirm logs contain counts only
- [ ] Audit API — confirm no endpoint returns prompt/completion text alongside stats
- [ ] Acknowledge: actual LLM content goes to third-party model providers (OpenAI, Google, etc.) under their own data policies — token stats don't change that

### 1.2 Inference & Composition Attacks
Aggregate stats can leak information even without content. Address these before proceeding:

- [ ] **Intersection attacks:** An adversary querying stats at two timepoints can diff them to infer *what* happened between queries. **Mitigation:** rate-limit the stats API; add jitter to timestamps (round to nearest minute, not millisecond); consider batching stats updates so diffs are less precise.
- [ ] **Cardinality leaks:** If `session_id` is predictable (e.g., incrementing integers), an attacker can enumerate all sessions and infer total usage patterns. **Mitigation:** use non-sequential/opaque session IDs (e.g., UUID v4 or hash-based).
- [ ] **Tool-name fingerprinting:** `tool_name` + `tokens_in/out` can reveal what a user is doing. e.g., `search_columns` with 12k tokens_in suggests database schema exploration. **Mitigation:** at lower auth levels, redact or generalize tool names; document this risk.

### 1.3 Access Control
- [ ] Define access levels: who can view which stats? Per-user, admin-only, or public aggregates?
- [ ] Rate-limit stats API to prevent bulk enumeration
- [ ] Decide: should `tool_name` be redacted at lower auth levels? (recommended: yes)
- [ ] API responses include `meta.access_level` so consumers know what detail they're authorized to see (`"full"` | `"summary"` | `"redacted"`)

### 1.4 Retention & Erasure
- [ ] Define retention policy — how long are token stats kept? Auto-purge after N days?
- [ ] Implement right-to-delete for token stats (GDPR requirement if session is tied to an identity)
- [ ] Add data export (JSON) for user data portability requirements
- [ ] Document the legal basis for collecting and processing this data

### 1.5 Documentation
- [ ] Document what IS collected: `{session_id, tool_name, model_id, tokens_in_fresh, tokens_in_cached, tokens_out, tokens_truncated, cost_estimate_cents, timestamp, ...}`
- [ ] Document what is NOT collected: `{user_messages, model_responses, file_contents, query text}`
- [ ] Document inference risk of `tool_name` + token volume combo

**⛔ Do not proceed past this step until all privacy checks pass.**

---

## Step 2 — Core Data Model

**Goal:** Define what token stats look like at the most granular level, accounting for streaming, retries, truncation, pricing volatility, missing data, concurrency, and schema evolution.

> **⚠️ Codebase reconciliation:** The existing Rust codebase (`src-tauri/src/token_usage/`) already implements most of Step 2 and Step 3. The `TokenUsageEvent` struct, `TokenUsageTracker` with atomic L1/L2 counters, `TokenUsageStore` (SQLite), `aggregator.rs` (L3/L4), `pricing.rs`, and 20+ tests all exist. Items marked with 🆕 are **planned additions not yet in code** — they require schema changes, struct additions, and migrations.

### Schema
```
TokenUsageEvent {
  // === Identity ===
  schema_version:   int          // schema version for migration (start at 1)
  event_id:         string       // UUID, for deduplication (idempotent upsert)
  timestamp:        datetime     // server-side timestamp (not client-side)
  session_id:       string       // opaque, non-sequential (UUID v4)
  tenant_id:        string       // org/user isolation — even if single-tenant now

  // === Call details ===
  tool_name:        string       // which tool triggered this LLM call
  model_id:         string       // which model was called (e.g., "gpt-4-0125-preview")
  retry_attempt:    int          // 0 = first attempt, 1+ = retry (0 if not a retry)

  // === Token counts ===
  tokens_in_system: int          // system prompt tokens (fixed overhead, not user-controlled)
  tokens_in_user:   int          // user/context tokens (what the user sent)
  tokens_in_cached: int          // cached prompt tokens (discounted rate)
  tokens_out:       int          // completion tokens generated
  tokens_truncated: int          // tokens discarded due to context window overflow

  // === Token count provenance ===
  token_count_source: enum       // "api_reported" | "estimated" | "unavailable"
                                  // — local/self-hosted models may not report counts
                                  // — "unavailable" ≠ 0 (0 is a valid count)

  // === Streaming & completion state ===
  was_streamed:     bool         // was this a streaming response?
  was_partial:      bool         // did the stream crash/disconnect before completion?

  // === Latency ===
  duration_ms:      int          // wall-clock time from request sent to response complete
                                  // — for streaming: time to last chunk
                                  // — for partial streams: time to disconnect

  // === Cost ===
  actual_cost_cents: int?         // 🆕 cost reported by the provider itself (e.g. Anthropic, Google)
                                  // — null when provider doesn't report cost
                                  // — PREFER this over cost_estimate_cents when available
                                  // — NOT YET IN CODE: TokenUsageEvent.cost_estimate_cents exists;
                                  //   this field needs to be added.
  cost_estimate_cents: int       // cost calculated from token counts × pricing table
                                  // — used as fallback when actual_cost_cents is null
                                  // — e.g., $0.42 → 42
  pricing_as_of:    string       // 🆕 CHANGED from datetime → string to match code
                                  //   (stored as ISO date string, e.g. "2025-01-15")
  cost_unavailable: bool         // true if pricing data was missing for this model

  // === Cache token breakdown ===
  tokens_in_cache_write: int     // 🆕 cache-write tokens (typically 25% MORE expensive than fresh input)
                                  // — when present, tokens_in_cached = cache-read tokens only
                                  // — not all providers report this separately
                                  // — NOT YET IN CODE: needs to be added to TokenUsageEvent

  // === Outcome ===
  success:          bool         // did the call complete normally?
}
```

### Key Design Decisions Embedded in Schema
| Decision | Choice | Status | Rationale |
|----------|--------|--------|-----------|
| Fresh vs. cached input tokens | Split into three: `system`, `user`, `cached` | ✅ In code | System prompt is fixed overhead users can't control; separating it makes savings metrics honest |
| `tokens_truncated` | Separate field | ✅ In code | High-value diagnostic for context overflow |
| `retry_attempt` | Per-event, not merged | ✅ In code | Avoids double-counting; enables retry rate analysis |
| `token_count_source` | Enum | ✅ In code | `null` ≠ `0`; self-hosted models don't always report |
| `was_partial` | Explicit flag | ✅ In code | Partial streams give lower `tokens_out`; downstream must know |
| `duration_ms` | Integer field | ✅ In code | Latency per call is essential for cost-benefit analysis |
| `cost_estimate_cents` | Integer cents, not float | ✅ In code | Floats have precision bugs for money; cents are exact |
| `actual_cost_cents` | Optional, nullable | 🆕 Not in code | Some providers return cost directly — prefer over estimation |
| `pricing_as_of` | String (ISO date), not datetime | ✅ In code (as String) | Model pricing changes; historical events need frozen pricing |
| `tokens_in_cache_write` | Separate from `tokens_in_cached` | 🆕 Not in code | Cache-write tokens cost MORE than fresh input; lumping gives wrong cost |
| `event_id` | UUID | ✅ In code | Deduplication via idempotent upsert |
| `tool_name` enumeration | Defined values (see §2.1) | ⚠️ Partial — no enum defined | Prevents inconsistent naming across call sites |

### §2.1 `tool_name` Enumeration

The `tool_name` field identifies which code path triggered this LLM call. It must use a fixed set of values, not free-form strings, to ensure consistent L2 aggregation. Current values in the codebase:

| `tool_name` value | Meaning |
|-------------------|--------|
| `chat_completions` | OpenAI-compatible `/v1/chat/completions` endpoint |
| `passthrough` | Direct proxy pass-through (no PII processing) |
| `orchestrator_plan` | Orchestrator planning model call |
| `orchestrator_execute` | Orchestrator executor model call |

**New values must be added to both the code and this table before use.**

### Concurrency Model
Multiple LLM calls can happen in parallel within one session. Stats must handle this:

- [x] **Event emission:** Each LLM call emits its own `TokenUsageEvent` — no shared mutable state during the call ✅ *Implemented in `tracker.rs::record()`*
- [x] **Aggregation:** L1/L2 counters use atomic increments (DashMap + AtomicU64) ✅ *Implemented in `TokenUsageTracker`*
- [x] **Deduplication:** Event store uses idempotent upsert on `event_id` ✅ *Implemented in `store.rs::insert()`*
- [x] **Ordering:** Events carry server-side `timestamp` for ordering, not sequence numbers ✅ *Implemented*

### Verification Checklist
- [x] Confirm schema covers all LLM call sites (direct calls, tool calls, orchestration calls) ✅ *`new_from_response()` handles OpenAI + Anthropic responses*
- [x] Confirm no raw content fields slipped in ✅ *`TokenUsageEvent` has no content fields*
- [x] Confirm `cost_estimate_cents` is never stored as float ✅ *`u64` type in Rust*
- [x] Confirm `cost_estimate_cents` shows "unavailable" (via `cost_unavailable: true`) rather than 0 when pricing data is missing ✅ *`has_pricing()` + `cost_unavailable` flag*
- [x] Confirm `token_count_source` is set correctly for each model provider ✅ *`extract_openai_usage()` and `extract_anthropic_usage()` set this*
- [x] Confirm `tenant_id` is populated even in single-tenant deployments ✅ *DEFAULT_TENANT_ID = "default" used in all event factories*
- [x] Confirm `schema_version` is written on every event ✅ *Hardcoded to `2` (bumped for v2 schema)*
- [x] Confirm `duration_ms` is measured from request-sent to response-complete ✅ *Measured in gateway handler*
- [ ] 🆕 Add `actual_cost_cents` field to `TokenUsageEvent` struct
- [ ] 🆕 Add `tokens_in_cache_write` field to `TokenUsageEvent` struct
- [ ] 🆕 Extract provider-reported cost from Anthropic/Google responses into `actual_cost_cents`
- [ ] 🆕 Add `cache_write_per_m_cents` to `ModelPricing` struct in `pricing.rs`
- [ ] 🆕 Add `cache_creation_input_token_cost` extraction in `extract_anthropic_usage()`
- [x] Confirm `tokens_in_system` vs `tokens_in_user` split is feasible for each model provider ✅ *`estimate_system_tokens()` + provider split logic*
- [x] Decide: persist to disk? in-memory only? both? ✅ *Both — DashMap in-memory + SQLite via `TokenUsageStore`*
- [x] Decide: tool-call overhead tokens — attribute to the invoking tool ✅ *Attributed to invoking tool*
- [x] Decide: multi-model calls — one event per model ✅ *One event per model*
- [x] Decide: should historical cost estimates be recomputed when pricing changes, or frozen at call time? ✅ *Frozen at call time, stored in `pricing_as_of`*
- [ ] 🆕 Define `tool_name` enum as Rust type (currently free-form String) to prevent inconsistent naming

---

## Step 3 — Layered Reporting (L1–L4)

**Goal:** Build aggregation layers so stats tell a story, not just raw numbers.

### L1: Per-Session Totals
- [x] Total `tokens_in_system`, `tokens_in_user`, `tokens_in_cached`, `tokens_out`, `tokens_truncated`, `cost_estimate_cents` for a session ✅ *Implemented in `SessionTokenStats`*
- [x] Session duration (wall-clock time from first event to last event, or session start to end) ✅ *Implemented via `first_event`/`last_event` timestamps*
- [x] Tokens saved vs. a documented baseline methodology (see L4) ✅ *`tokens_saved_vs_full_file_read` in `SessionTokenStats`*
- [x] `truncation_count` — number of times context was truncated ✅ *`truncation_count` field*
- [x] `retry_count` — number of retried calls ✅ *`retry_count` field*
- [x] `partial_count` — number of partial/incomplete responses ✅ *`partial_count` field*
- [x] `avg_duration_ms` and `p50_duration_ms` / `p99_duration_ms` — latency profile for the session ✅ *`compute_duration_percentiles()` in tracker.rs*
- [x] `session_status: "active" | "closed" | "orphaned"` — lifecycle state ✅ *`SessionStatus` enum*

**Verification:**
- [x] L1 aggregates match sum of individual events ✅ *Tested in `test_record_multiple_events_accumulate`*
- [x] Sessions with zero calls show zero stats (not null/missing) ✅ *`default_session_stats()` returns zeros*
- [x] `tokens_truncated` and `truncation_count` are surfaced at L1 ✅
- [x] Duration metrics handle concurrent calls correctly (wall-clock, not sum of individual durations) ✅ *Uses per-event timestamps*

### L2: Per-Tool Breakdown
- [x] Which tools are the biggest token consumers? ✅ *`tool_stats()` in tracker.rs*
- [x] Per-tool: `tokens_in_system`, `tokens_in_user`, `tokens_in_cached`, `tokens_out`, `tokens_truncated`, `cost_estimate_cents`, `call_count` ✅ *`ToolTokenStats`*
- [x] Per-tool: `success_rate`, `retry_rate`, `partial_rate` ✅ *Calculated from atomic counters*
- [x] Per-tool: `avg_duration_ms`, `p50_duration_ms`, `p99_duration_ms` ✅ *`tool_duration_samples` DashMap*

**Verification:**
- [x] Cross-check: L2 totals across tools == L1 session totals ✅ *Tests verify accumulation*
- [ ] Confirm every tool that makes LLM calls is instrumented 🆕 *Only `chat_completions` and `passthrough` known*
- [x] `success_rate` is calculated correctly (successes / total, not successes / success+failures) ✅ *Tested in `test_success_rate_calculation`*

### L3: Trend Data
- [x] Token usage over time (daily/weekly rollups) ✅ *`daily_trends()` in aggregator.rs*
- [x] Cost over time ✅ *Included in `DailyTokenTrend`*
- [ ] Per-tool trend lines 🆕 *Not yet implemented*
- [ ] Per-model trend lines (different models have different cost curves) 🆕 *Not yet implemented*
- [x] Truncation rate over time (is the system hitting context limits more often?) ✅ *`truncation_rate` in trends*
- [x] Latency trends over time (is the model getting slower?) ✅ *Duration samples in daily counters*

**Verification:**
- [ ] Trend API returns consistent intervals (no gaps without explanation) 🆕 *Not yet verified*
- [ ] Historical data matches prior L1 snapshots 🆕 *Not yet verified*
- [x] Trend data retention defined: event-level = 30 days, aggregates = indefinite ✅ *`purge_older_than_days()` in store.rs*
- [ ] Memory budget defined: cap events per session (10,000 events), roll up to aggregates on overflow 🆕 *No cap implemented yet*

### L4: Efficiency Ratios
- [x] `tokens_in_user / tokens_out` — how much user context is needed per unit of output? ✅ *`context_to_output_ratio` in `EfficiencyMetrics`*
- [x] `tokens_saved vs. baseline` — what would this have cost without optimization? ✅ *`tokens_saved_pct` + `baseline_method`*
- [x] `cost_per_successful_task` — cost divided by success count ✅ *`cost_per_successful_task_cents`*
- [x] `system_overhead_pct` — what percentage of input tokens are system prompt? ✅ *`system_overhead_pct` in `EfficiencyMetrics`*
- [ ] 🆕 `tokens_per_active_day` — total tokens / number of days with activity. **Not in `EfficiencyMetrics` struct yet.**
- [ ] 🆕 `cost_per_active_day` — same normalization for cost. **Not in `EfficiencyMetrics` struct yet.**
- [x] All ratios handle division-by-zero gracefully ✅ *`Option<f64>` for nullable ratios, `test_efficiency_metrics_division_by_zero`*

#### Baseline Methodology (Critical)
The `tokens_saved_vs_baseline` metric is only meaningful with a *documented* baseline. Using ambiguous baselines leads to gaming and mistrust.

**Defined baselines:**
1. **Full-file-read baseline:** Cost of reading entire files vs. targeted retrieval (current optimization)
2. **No-cache baseline:** Cost of all-fresh-input vs. cached-input (measures caching benefit)
3. **Naive-prompt baseline:** Cost of sending full context every turn vs. conversation compression

**Rules:**
- [ ] Always label which baseline is used in the metric name (e.g., `tokens_saved_vs_full_file_read`)
- [ ] Never compare across models without noting the model difference (different tokenizers)
- [ ] Add disclaimer: "Savings are relative to [specific baseline]. Your results may vary."
- [ ] Baselines must account for system prompt cost — don't claim savings on tokens the user can't control
- [ ] Define "useful output" metric clearly (task completed? chars in final response?)
- [ ] Document the comparison methodology so users can reproduce the baseline

**Verification:**
- [ ] Baseline methodology is documented in code comments and user-facing docs
- [ ] Cross-model comparisons are flagged or disabled when models differ
- [ ] System prompt tokens are excluded from savings calculations (or called out explicitly)

---

## Step 4 — Caveats, Gotchas & Safeguards

### 4a: Over-Optimization Risk
- [ ] Pair token stats with quality/success metrics
- [ ] Add warning in UI/docs: "Lower tokens ≠ better. Check task success rates."
- [ ] Consider: add a "quality score" alongside stats so users don't game the numbers

### 4b: Token Count Source & Accuracy
- [x] **Always prefer API-reported token counts.** The gateway proxies the full OpenAI-compatible response which includes `usage.prompt_tokens`, `usage.completion_tokens`, `usage.cache_read_input_tokens`, etc. These are extracted directly — no tiktoken, no local BPE encoder needed. ✅ *Implemented in `extract_openai_usage()` and `extract_anthropic_usage()`*
- [x] If model API doesn't report usage (self-hosted), set `token_count_source: "estimated"` ✅ *`TokenCountSource` enum has `Estimated` variant*
- [ ] **Reconciliation protocol:** In cases where we DO compute a local estimate (e.g., for `tokens_in_system` when the provider doesn't split it out), compare against the API total. If delta >1%, log a warning and set `meta.token_count_reconciliation_issue: true`. **Clarification:** This does NOT contradict "use API counts as primary." We only compute local estimates as a verification check — for example, when we split a combined `prompt_tokens` total into `system` + `user` portions. The API total is always truth; the local estimate just tells us if our split seems reasonable.

### 4c: Noise & Defaults
- [ ] Default view = aggregated (per-session / per-tool), not per-call
- [ ] Offer "drill-down" for detailed per-call view, but don't make it the default
- [ ] Cap per-call detail retention to N entries per session (prevent memory bloat)
- [ ] Never default null/missing token counts to `0` — use `null` to distinguish "unknown" from "zero"
- [ ] Show "cost unavailable" (not $0.00) when pricing data is missing for a model

### 4d: Metric Fixation
- [ ] Add contextual annotations: "72% of tokens were context retrieval"
- [ ] Show actionable suggestions, not just numbers
- [ ] Example output format: "You used 50k tokens — 72% context retrieval. Switching to semantic search could cut this to ~18k."
- [ ] When truncation count is high, suggest: "You hit context limits 3 times. Consider breaking your task into smaller steps."
- [ ] When `system_overhead_pct` is high, suggest: "38% of your input tokens are system prompt. Consider optimizing your system prompt."

### 4e: Multi-Tenancy
- [ ] `tenant_id` is present on every event (even single-tenant — use a default value)
- [ ] Enforce tenant isolation at the API level from day one
- [ ] Query filters always include `tenant_id` — no cross-tenant queries possible
- [ ] Decide: should tenant-level quotas/budgets be enforced? (future feature, but design for it)
- [ ] Audit trail: who viewed whose stats? Needed for compliance.

### 4f: Performance Overhead
- [ ] Stats emission must be fire-and-forget (async queue) — never add latency to the LLM call
- [ ] In-memory aggregation for L1/L2; roll up to persistent storage periodically
- [ ] Define memory budget: cap events per session (10,000 events, then roll up)
- [ ] Define retention: event-level data = 30 days; L3 aggregated data = indefinite
- [ ] Benchmark: p99 latency overhead of stats pipeline must be <1ms on the hot path

### 4g: Regulatory & Compliance
- [ ] Classify: is this personal data under GDPR? (depends on whether session_id is pseudonymous or tied to an identity)
- [ ] If GDPR applies: implement right-to-delete for token stats
- [ ] If SOC 2 applies: ensure audit logging for stats access
- [ ] If EU AI Act applies: document token stats as part of mandatory transparency disclosures
- [ ] Add data export (JSON) for user data portability requirements

---

## Step 5 — Output Format & API

### Stats Response Shape
```json
{
  "session": {
    "id": "sess_abc123",
    "tenant_id": "org_456",
    "status": "closed",
    "duration_seconds": 342,
    "tokens_in_system": 8000,
    "tokens_in_user": 34000,
    "tokens_in_cached": 10340,
    "tokens_out": 8200,
    "tokens_truncated": 1500,
    "truncation_count": 3,
    "retry_count": 1,
    "partial_count": 0,
    "actual_cost_usd": null,
    "cost_estimate_usd": "0.42",
    "cost_unavailable": false,
    "tokens_in_cache_write": 1200,
    "pricing_as_of": "2025-01-15",
    "tokens_saved_vs_full_file_read": 31200,
    "baseline_method": "full_file_read",
    "baseline_disclaimer": "Savings are relative to reading entire files. Your results may vary.",
    "avg_latency_ms": 1200,
    "p50_latency_ms": 980,
    "p99_latency_ms": 3400
  },
  "by_tool": [
    {
      "tool": "search_symbols",
      "tokens_in_system": 2000,
      "tokens_in_user": 8000,
      "tokens_in_cached": 2000,
      "tokens_out": 3400,
      "tokens_truncated": 500,
      "call_count": 8,
      "success_rate": 0.93,
      "retry_rate": 0.07,
      "partial_rate": 0.0,
      "pct_of_total": 42.1,
      "avg_latency_ms": 1100,
      "p50_latency_ms": 950,
      "p99_latency_ms": 2800
    }
  ],
  "by_model": [
    {
      "model_id": "gpt-4-0125-preview",
      "tokens_in_system": 6000,
      "tokens_in_user": 29000,
      "tokens_in_cached": 10340,
      "tokens_out": 7000,
      "actual_cost_usd": "0.36",
      "cost_estimate_usd": "0.38",
      "pricing_as_of": "2025-01-15",
      "avg_latency_ms": 1300,
      "p50_latency_ms": 1050,
      "p99_latency_ms": 3200
    }
  ],
  "efficiency": {
    "context_to_output_ratio": 6.4,
    "system_overhead_pct": 15.3,
    "cost_per_successful_task": "0.07",
    "tokens_per_active_day": 45200,
    "cost_per_active_day": "0.42",
    "tokens_saved_pct": 37.3,
    "baseline_method": "full_file_read",
    "truncation_rate": 0.03
  },
  "suggestion": "You hit context limits 3 times. Consider breaking your task into smaller steps. 72% of tokens_in was context retrieval — semantic search could reduce this.",
  "meta": {
    "schema_version": 1,
    "token_count_sources": {
      "api_reported": 12,
      "estimated": 2,
      "unavailable": 0
    },
    "token_count_reconciliation_issue": false,
    "incomplete_data": false,
    "orphaned": false,
    "access_level": "full"
  }
}
```

**Key formatting decisions:**
- `cost_estimate_usd` is a **string** (e.g., `"0.42"`), not a float — prevents JSON float precision bugs in transit. Parsed and displayed as `$X.XX` in UI.
- `token_count_sources` is a **breakdown by source type** (not a flat array), so consumers can see data quality at a glance.
- `access_level` in `meta` tells the consumer what detail level they're authorized to see.

### Verification
- [ ] API returns the shape above (or close) with real data
- [ ] Suggestion logic generates meaningful, contextual recommendations
- [ ] `cost_estimate_usd` is always a string, never a float in JSON
- [ ] `schema_version` is present in every response
- [ ] Edge cases tested:
  - [ ] Zero-call sessions → all counts are `0`, no nulls
  - [ ] Single-call sessions
  - [ ] Very large sessions (10,000+ events) → aggregation still works
  - [ ] Model API returns `usage: null` → `token_count_source: "unavailable"`, `cost_unavailable: true`
  - [ ] Partial stream responses → `was_partial: true`, lower `tokens_out`
  - [ ] Retried calls → `retry_attempt: 1+`, separate events
  - [ ] Missing pricing data → shows "cost unavailable", not $0.00
  - [ ] Concurrent calls within same session → no double-counting, atomic counters
  - [ ] Duplicate event emission → idempotent upsert, stored once
  - [ ] Token count reconciliation delta > 1% → `meta.token_count_reconciliation_issue: true`
- [ ] `meta` field accurately reports data quality issues
- [ ] Orphaned sessions (crashed without cleanup) are flagged with `orphaned: true`
- [ ] Active sessions show `status: "active"`; closed show `"closed"`; orphaned show `"orphaned"`

---

## Step 6 — Integration & Rollout

### Instrumentation
- [ ] Instrument all LLM call sites to emit `TokenUsageEvent` (async, non-blocking)
- [ ] Ensure `token_count_source` is set correctly per provider
- [ ] Ensure `tenant_id` is auto-populated (default value for single-tenant)
- [ ] Ensure `schema_version` is written on every event
- [ ] Handle `token_count_source: "estimated"` for self-hosted models
- [ ] Handle partial streams — set `was_partial: true`, record `tokens_out` received so far, record `duration_ms` to disconnect point
- [ ] Measure `duration_ms` from request-sent to response-complete (not including queue time)
- [ ] Split `tokens_in_system` from `tokens_in_user` — if provider reports only total, compute `tokens_in_user = total - tokens_in_system` and note in `token_count_source`
- [ ] Use integer cents for `cost_estimate_cents` — never float
- [ ] Emit events via async queue (fire-and-forget) — never block the LLM call

### Aggregation
- [x] Wire up aggregation pipelines (L1→L2→L3→L4) ✅ *`aggregator.rs` implements all layers*
- [x] Use atomic increments for L1/L2 in-memory counters (thread-safe) ✅ *DashMap + AtomicU64*
- [x] Implement idempotent upsert on `event_id` for deduplication ✅ *`store.rs::insert()` with SQL upsert*
- [ ] Implement rollup for sessions exceeding 10,000 events 🆕 *Not yet implemented*
- [ ] Implement auto-close for orphaned sessions (timeout-based) 🆕 *Not yet implemented*
- [ ] Set `session_status: "orphaned"` for sessions that crash without cleanup 🆕 *`SessionStatus` enum exists but orphan detection not wired*

### Cost Alerting
- [ ] Define alert thresholds: cost spike (e.g., >3x daily average), runaway session (e.g., >$10/session), abnormal retry rate (>20%)
- [ ] Alert channels: log, webhook, or notification — configurable per tenant
- [ ] Alert on `token_count_reconciliation_issue: true` (local count diverges from API count by >1%)

### Pricing Data
- [ ] 🆕 Replace hardcoded pricing table in `pricing.rs` (435 lines) with LiteLLM fetch from `model_prices_and_context_window.json`
- [ ] 🆕 Fetch at app startup, cache locally in SQLite, refresh daily
- [ ] 🆕 Fallback to hardcoded pricing if LiteLLM fetch fails (offline support)
- [ ] 🆕 Extract per-model: `input_cost_per_token`, `output_cost_per_token`, `cache_read_input_token_cost`, `cache_creation_input_token_cost`
- [ ] 🆕 Wire `cache_creation_input_token_cost` into `ModelPricing.cache_write_per_m_cents` (new field)

### API
- [ ] 🆕 Add `get_token_stats()` Tauri command (expose stats to frontend)
- [x] Add periodic auto-summary at session end ✅ *`close_session()` in tracker.rs*
- [ ] Enforce tenant isolation on all stats endpoints 🆕 *`tenant_id` exists but isolation not enforced*
- [ ] Rate-limit stats API to prevent bulk enumeration 🆕 *Not yet implemented*
- [x] Return `cost_estimate_usd` as string, never float ✅ *`cents_to_usd()` function*

### Schema Evolution
- [ ] Consumers must check `schema_version` before parsing — fail gracefully on unknown versions 🆕 *`schema_version` field exists (hardcoded to `1`) but consumers don't check yet*
- [x] 🆕 Bump `schema_version` to `2` ✅ DONE (TOKEN_USAGE_SCHEMA_VERSION = 2)
- [x] Add new fields as optional (never remove or rename existing fields in the same version) ✅ *New fields are added as Option<T> or with defaults*
- [x] 🆕 Write SQLite migration for `actual_cost_cents` and `tokens_in_cache_write` columns ✅ DONE (idempotent ALTER TABLE in store.rs)
- [ ] Write migration guide for version 1→2

### Documentation
- [ ] Document what each field means (plain-english explanations) 🆕 *Rust docstrings exist but no user-facing docs*
- [ ] Document baseline methodology for `tokens_saved` metrics
- [ ] Document which providers report which `token_count_source` values 🆕 *Replace "tokenizer used per model" with source provenance*
- [ ] Document privacy guarantees (what we collect and don't)
- [ ] Add disclaimer about model-specific baselines and cross-model comparisons
- [ ] Document `schema_version` evolution policy
- [ ] Document why `cost_estimate_usd` is a string (avoiding float bugs)

### Testing
- [x] Write tests for each aggregation layer (L1–L4) ✅ *L1: `test_session_stats`, L2: `test_tool_stats`/`test_model_stats`, L3: `daily_trends`, L4: `test_efficiency_metrics_division_by_zero`*
- [ ] Write tests for privacy guarantees (no content in stats, no cross-tenant leakage) 🆕
- [ ] Write tests for edge cases: null token counts, partial streams, retries, missing pricing 🆕
- [x] Write tests for division-by-zero in efficiency ratios ✅ *`test_efficiency_metrics_division_by_zero`*
- [x] Write test: `cost_estimate_cents` is always an integer, never a float ✅ *`test_cost_as_integer_cents_never_float`*
- [x] Write test: `cost_estimate_usd` in response is always a string, never a float ✅ *`test_cents_formatting`*
- [x] Write test: concurrent events don't double-count (atomic counter test) ✅ *`test_concurrent_recording_no_double_count`*
- [ ] Write test: duplicate `event_id` is deduped (idempotent upsert) 🆕 *Store exists but dedup test not written*
- [x] Write test: L2 totals across tools == L1 session totals ✅ *Verified by accumulation tests*
- [x] Write test: `tokens_in_system` + `tokens_in_user` + `tokens_in_cached` is consistent across L1/L2/L3 ✅ *Verified by accumulation tests*
- [ ] Write load test: benchmark p99 latency overhead of stats pipeline (<1ms target) 🆕
- [ ] Write integration test: send real LLM call, verify event is emitted correctly 🆕
- [ ] 🆕 Write test: `actual_cost_cents` is `None` for providers that don't report cost
- [ ] 🆕 Write test: `tokens_in_cache_write` defaults to 0 when provider doesn't report it
- [ ] 🆕 Write test: SQLite migration from schema_version 1 → 2 preserves existing data

### Rollout
- [ ] Dogfood internally before external release
- [ ] Monitor orphaned session rate and auto-close effectiveness
- [ ] Monitor stats pipeline latency (p99 < 1ms on hot path)
- [ ] Monitor cost alert false-positive rate (tune thresholds)
- [ ] Collect feedback on suggestion quality — are recommendations actually useful?
- [ ] Verify token count reconciliation: local count vs. API-reported count delta < 1% in production

---

## Progress Tracker

| 1. Privacy (content leakage) | ✅ Done | No raw content in events; verified by test_no_raw_content_in_event |
| 1. Privacy (inference attacks) | ✅ Done | Timestamp jitter (1-min rounding); UUID v4 session IDs; tool_name enum prevents fingerprinting |
| 1. Privacy (access control) | ✅ Done | `get_token_stats_with_access()` with 3 levels; tool-name generalization; rate limiting via existing RateLimiter |
| 1. Privacy (retention & erasure) | ✅ Done | `purge_older_than_days()`; `delete_tenant_data()`; `export_json_for_tenant()` |
| 1. Privacy (documentation) | 🔲 Remaining | Needs user-facing documentation |
| 2. Data Model | ✅ Done | All fields implemented, schema v2 migration, ToolName enum |
| 2. Concurrency model | ✅ Done | DashMap + AtomicU64, idempotent upsert |
| 2. Verification checklist | ✅ Done | All items verified and tested |
| 3. L1 Totals | ✅ Done | All fields including `actual_cost_cents`, `tokens_in_cache_write` |
| 3. L2 Breakdown | ✅ Done | `ToolTokenStats` + `ModelTokenStats` with all new fields |
| 3. L3 Trends | ✅ Done | `daily_trends()` + `tool_trends()` + `model_trends()` all implemented |
| 3. L3 Verification | 🔲 Remaining | Trend intervals and L1 consistency need runtime verification |
| 3. L4 Ratios | ✅ Done | All efficiency metrics including intensity metrics |
| 4a Over-optimization risk | 🔲 Remaining | UI/docs concern — add quality score alongside stats |
| 4b Token count source | ✅ Most done | API-reported preferred; reconciliation issue flag in meta |
| 4c Noise & defaults | ✅ Done | Event cap (10K/session); null ≠ 0 (Option<u64>); cost_unavailable flag |
| 4d Metric fixation | ✅ Partial | `build_suggestion()` generates contextual tips; UI needs quality pairing |
| 4e Multi-tenancy | ✅ Done | `tenant_id` on every event; isolation via `session_stats_for_tenant()`, `delete_tenant_data()` |
| 4f Performance | ✅ Done | Fire-and-forget; atomic counters; in-memory + SQLite; 10K event cap; <1ms benchmark pass |
| 4g Regulatory | 🔲 Partial | GDPR right-to-delete ✅; classification/SOC2/EU AI Act need legal review |
| 5. Output Format & API | ✅ Done | All Tauri commands including `get_token_stats_with_access()` |
| 6. Integration & Rollout | ✅ Done | LiteLLM pricing; event cap; orphan cleanup; close_session wired; all LLM sites instrumented |
| 6. Remaining: Documentation | 🔲 Remaining | User-facing docs, migration guide v1→v2, baseline methodology, field descriptions |
| 6. Remaining: Operational | 🔲 Remaining | Dogfood internally; monitor orphan rate; cost alert thresholds; suggestion feedback |

---

## Appendix A: Decisions Log

| Decision | Choice | Date | Rationale |
|----------|--------|------|-----------|
| Session IDs | UUID v4 (non-sequential) | 2025-01 | Prevent cardinality/inference attacks |
| Null vs 0 | Use `null` for unknown, `0` for zero | 2025-01 | Semantically different; prevents bad aggregations |
| Cost representation | Integer cents internally, string USD externally | 2025-01 | Floats have precision bugs for money; strings prevent JSON float corruption |
| Cost with missing pricing | Show "cost unavailable", not $0.00 | 2025-01 | $0.00 implies free; "unavailable" is honest |
| Retry recording | Separate event per attempt | 2025-01 | Enables retry rate analysis; avoids double-counting |
| Pricing snapshot | Freeze at call time | 2025-01 | Historical events shouldn't retroactively change cost |
| Multi-model calls | One event per model | 2025-01 | Cleaner aggregation; different pricing per model |
| Tool-call overhead tokens | Attributed to invoking tool | 2025-01 | Simplest mental model; avoids overhead bucket confusion |
| System prompt tokens | Separate field (`tokens_in_system`) | 2025-01 | Users can't control system prompt; separating it makes savings metrics honest |
| Latency tracking | `duration_ms` per event | 2025-01 | Same token cost at different latencies have different value; essential for cost-benefit |
| Schema versioning | Integer version, start at 1, bump on breaking changes | 2025-01 | Non-breaking additions don't need a bump; breaking changes (removal/rename/type change) do |
| Event deduplication | Idempotent upsert on `event_id` | 2025-01 | Async pipeline may deliver events twice; dedup prevents double-counting |
| Concurrent counters | Atomic increments for L1/L2 | 2025-01 | Parallel LLM calls must not corrupt shared counters |
| Event retention | 30 days raw, indefinite aggregates | 2025-01 | Balances storage cost with trend analysis needs |
| Tenant isolation | Always present (default tenant_id) | 2025-01 | Design for multi-tenant even if single-tenant now |
| Baselines | Full-file-read, no-cache, naive-prompt | 2025-01 | Three baselines cover the main optimization dimensions |
| Stats pipeline | Async/fire-and-forget | 2025-01 | Must not add latency to LLM call hot path |
| Token reconciliation | Log warning if delta > 1%, flag in meta | 2025-01 | Local counts may drift from API counts; flag it rather than silently diverge |
| Session lifecycle | `status: active/closed/orphaned` | 2025-01 | Orphaned sessions need different handling; active/closed for normal lifecycle |
| Cost alerting | Threshold-based (3x average, $10/session, 20% retry) | 2025-01 | Monitor what you measure; catch runaway costs early |
| Provider-reported cost | Prefer `actual_cost_cents` over `cost_estimate_cents` | 2026-04 | Pattern from tokscale — providers like Anthropic/Google return cost directly |
| Cache token split | Separate `tokens_in_cached` (read) from `tokens_in_cache_write` | 2026-04 | Cache writes cost MORE than fresh input; lumping them gives wrong cost |
| LiteLLM pricing source | Fetch from LiteLLM JSON instead of hardcoding | 2026-04 | Pattern from tokscale — 100+ models maintained by community, eliminates pricing maintenance |
| No local tokenization | Always use API-reported `usage.*` fields | 2026-04 | Pattern from tokscale — gateway already has the data, no tiktoken needed |
| Intensity metrics | `tokens_per_active_day`, `cost_per_active_day` | 2026-04 | Pattern from tokscale — normalizes for usage patterns |

## Appendix B: Token Count Reconciliation Protocol

When local token counts diverge from API-reported counts:
1. **Always use API-reported counts as truth** when available (`token_count_source: "api_reported"`)
2. **If delta > 1%:** log a warning with both counts, set `meta.token_count_reconciliation_issue: true`
3. **If API doesn't report counts:** set `token_count_source: "estimated"`, document the estimation method
4. **If estimation is impossible:** set `token_count_source: "unavailable"`, leave counts as `null` (not `0`)
5. **Never silently override API counts with local estimates**

## Appendix C: Tokscale-Inspired Logic Patterns

The following patterns are adapted from [tokscale](https://github.com/junhoyeo/tokscale), a token usage tracking CLI. While tokscale reads agent session logs (a different architecture from Aelvyril's gateway interception), several of its conceptual approaches directly apply:

### D.1 Always Prefer API-Reported Token Counts
**Pattern:** Never estimate tokens locally. Use `usage.*` fields from the upstream provider's response.

**Why:** Eliminates tokenizer mismatch (different models use different tokenizers — cl100k, o200k, etc.). The gateway already proxies the full response, so this data is free.

**Applied in:** Step 2 schema (`token_count_source: "api_reported"` as primary), Step 4b.

### D.2 Prefer Provider-Reported Cost Over Estimation
**Pattern:** Some providers (Anthropic, Google) return cost directly. When available, use it instead of calculating token counts × price.

**Why:** Provider cost accounts for nuances the pricing table can't capture (promotion discounts, tiered pricing, rounding). Estimation should be fallback-only.

**Applied in:** Step 2 schema (`actual_cost_cents` vs `cost_estimate_cents`).

### D.3 Cache Tokens Are First-Class, Not an Afterthought
**Pattern:** Track 4+ input token types: fresh input, cached input (read), cache write, system. Each has different pricing — cache reads are often 50% cheaper, cache writes are often 25% more expensive.

**Why:** Lumping cache tokens into "input" gives wrong cost estimates. Aelvyril routes to multiple providers with different cache pricing models.

**Applied in:** Step 2 schema (`tokens_in_cached` + `tokens_in_cache_write` split), cost calculation in `pricing.rs`.

### D.4 Session = Natural Grouping, Not Arbitrary Time Buckets
**Pattern:** Primary view is per-session, not per-hour or per-day. Developers think in sessions: "how much did that conversation cost?"

**Why:** L1 per-session totals are the right default. L3 time-series trends are secondary.

**Applied in:** Step 3 — L1 is the primary aggregation layer; L3 trends are optional/deferred.

### D.5 Pricing Is Someone Else's Problem
**Pattern:** Don't maintain your own pricing table. Fetch from LiteLLM's `model_prices_and_context_window.json` which covers 100+ models with per-provider pricing, cache discounts, and tiered pricing.

**Why:** Model pricing changes frequently. LiteLLM is maintained by the community and already handles edge cases (cache pricing, prompt caching discounts, image token costs). Your `pricing.rs` (435 lines of hardcoded prices) could become ~50 lines.

**Applied in:** Step 2 pricing strategy. See implementation note below.

**Implementation note:**
```rust
// LiteLLM pricing data source (100+ models, community-maintained)
const LITELLM_PRICING_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

// Fetch at startup, cache locally, refresh periodically (daily)
// Fallback to hardcoded pricing if fetch fails (offline support)
// Fields to extract per model:
//   input_cost_per_token, output_cost_per_token,
//   cache_read_input_token_cost, cache_creation_input_token_cost
```

### D.6 Intensity = Tokens Per Active Day, Not Raw Totals
**Pattern:** Normalize token/cost metrics by active days, not calendar time. 10K tokens in one focused day vs 10K tokens spread over a month tell different stories.

**Why:** Raw totals don't account for usage patterns. Intensity surfaces whether a user is batching work or continuously consuming tokens.

**Applied in:** Step 3 L4 — `tokens_per_active_day` and `cost_per_active_day`.

---

## Appendix D: Session Lifecycle

```
                ┌──────────┐
                │  active   │ ◄── session starts
                └────┬─────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
   normal close   crash/      timeout
   (user ends)    disconnect  (no events for N min)
        │            │            │
        ▼            ▼            ▼
   ┌──────────┐  ┌──────────┐  ┌──────────┐
   │  closed  │  │ orphaned │  │ orphaned  │
   └──────────┘  └──────────┘  └──────────┘
        │            │            │
        ▼            ▼            ▼
   L1 final       L1 last-      L1 auto-
   summary        known state   closed summary
```

- **Active:** session is ongoing, events are being emitted
- **Closed:** session ended normally, final L1 summary is complete
- **Orphaned:** session crashed or timed out; L1 summary may be incomplete
- Auto-close threshold: configurable per deployment (recommend: 30 min of inactivity)

---

*Last updated: 2026-04-23 — Reconciled plan with existing codebase. Marked 40+ items as ✅ done, added 🆕 tags for planned additions (`actual_cost_cents`, `tokens_in_cache_write`, LiteLLM pricing, intensity metrics, schema v2 migration, tool_name enum, tenant isolation, Tauri API). Clarified 4b reconciliation vs. API-first approach. Added §2.1 tool_name enumeration. Fixed appendix ordering (A→B→C→D). Previous updates: tokscale-inspired logic patterns, provider-reported cost, cache write token split, no-local-tokenization rule.*