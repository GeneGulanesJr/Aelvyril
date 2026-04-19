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
  cost_estimate_cents: int       // cost in integer cents (avoids float precision bugs)
                                  // — e.g., $0.42 → 42
  pricing_as_of:    datetime     // date the pricing table was last verified
  cost_unavailable: bool         // true if pricing data was missing for this model

  // === Outcome ===
  success:          bool         // did the call complete normally?
}
```

### Key Design Decisions Embedded in Schema
| Decision | Choice | Rationale |
|----------|--------|-----------|
| Fresh vs. cached input tokens | Split into three: `system`, `user`, `cached` | System prompt is fixed overhead users can't control; separating it makes savings metrics honest |
| `tokens_truncated` | Separate field | High-value diagnostic for context overflow |
| `retry_attempt` | Per-event, not merged | Avoids double-counting; enables retry rate analysis |
| `token_count_source` | Enum | `null` ≠ `0`; self-hosted models don't always report |
| `was_partial` | Explicit flag | Partial streams give lower `tokens_out`; downstream must know |
| `duration_ms` | Integer field | Latency per call is essential for cost-benefit analysis; different models at same token cost can have very different latencies |
| `cost_estimate_cents` | Integer cents, not float | Floats have precision bugs for money (0.1 + 0.2 ≠ 0.3); cents are exact; display as `$X.XX` in UI |
| `pricing_as_of` | Stored per event | Model pricing changes; historical events need frozen pricing |
| `tenant_id` | Always present | Multi-tenant isolation from day one |
| `schema_version` | Integer, starts at 1 | Enables non-breaking schema evolution; consumers can handle multiple versions |
| `event_id` | UUID | Deduplication via idempotent upsert — event store must enforce write-once per event_id |

### Concurrency Model
Multiple LLM calls can happen in parallel within one session. Stats must handle this:

- [ ] **Event emission:** Each LLM call emits its own `TokenUsageEvent` — no shared mutable state during the call
- [ ] **Aggregation:** L1/L2 counters use atomic increments (e.g., `Interlocked.Add` / `atomic_add` / thread-safe counters)
- [ ] **Deduplication:** Event store uses idempotent upsert on `event_id` — if the same event arrives twice (network retry, etc.), it's stored once
- [ ] **Ordering:** Events carry server-side `timestamp` for ordering, not sequence numbers (concurrent events may overlap)

### Verification Checklist
- [ ] Confirm schema covers all LLM call sites (direct calls, tool calls, orchestration calls)
- [ ] Confirm no raw content fields slipped in
- [ ] Confirm `cost_estimate_cents` is never stored as float
- [ ] Confirm `cost_estimate_cents` shows "unavailable" (via `cost_unavailable: true`) rather than 0 when pricing data is missing
- [ ] Confirm `token_count_source` is set correctly for each model provider
- [ ] Confirm `tenant_id` is populated even in single-tenant deployments
- [ ] Confirm `schema_version` is written on every event
- [ ] Confirm `duration_ms` is measured from request-sent to response-complete (not including queue time)
- [ ] Confirm `tokens_in_system` vs `tokens_in_user` split is feasible for each model provider (some report total only — if so, set `tokens_in_user = total - tokens_in_system` or flag it)
- [ ] Decide: persist to disk? in-memory only? both?
- [ ] Decide: tool-call overhead tokens — attribute to the invoking tool or a separate `"tool_call_overhead"` bucket
- [ ] Decide: multi-model calls (one request hitting 2+ models) get one event per model or one composite event
- [ ] Decide: should historical cost estimates be recomputed when pricing changes, or frozen at call time? **Recommendation: freeze at call time, store `pricing_as_of`**

---

## Step 3 — Layered Reporting (L1–L4)

**Goal:** Build aggregation layers so stats tell a story, not just raw numbers.

### L1: Per-Session Totals
- [ ] Total `tokens_in_system`, `tokens_in_user`, `tokens_in_cached`, `tokens_out`, `tokens_truncated`, `cost_estimate_cents` for a session
- [ ] Session duration (wall-clock time from first event to last event, or session start to end)
- [ ] Tokens saved vs. a documented baseline methodology (see L4)
- [ ] `truncation_count` — number of times context was truncated (high-value diagnostic)
- [ ] `retry_count` — number of retried calls (quality signal)
- [ ] `partial_count` — number of partial/incomplete responses
- [ ] `avg_duration_ms` and `p50_duration_ms` / `p99_duration_ms` — latency profile for the session
- [ ] `session_status: "active" | "closed" | "orphaned"` — lifecycle state

**Verification:**
- [ ] L1 aggregates match sum of individual events
- [ ] Sessions with zero calls show zero stats (not null/missing)
- [ ] `tokens_truncated` and `truncation_count` are surfaced at L1
- [ ] Duration metrics handle concurrent calls correctly (wall-clock, not sum of individual durations)

### L2: Per-Tool Breakdown
- [ ] Which tools are the biggest token consumers?
- [ ] Per-tool: `tokens_in_system`, `tokens_in_user`, `tokens_in_cached`, `tokens_out`, `tokens_truncated`, `cost_estimate_cents`, `call_count`
- [ ] Per-tool: `success_rate`, `retry_rate`, `partial_rate`
- [ ] Per-tool: `avg_duration_ms`, `p50_duration_ms`, `p99_duration_ms`

**Verification:**
- [ ] Cross-check: L2 totals across tools == L1 session totals
- [ ] Confirm every tool that makes LLM calls is instrumented
- [ ] `success_rate` is calculated correctly (successes / total, not successes / success+failures)

### L3: Trend Data
- [ ] Token usage over time (daily/weekly rollups)
- [ ] Cost over time
- [ ] Per-tool trend lines
- [ ] Per-model trend lines (different models have different cost curves)
- [ ] Truncation rate over time (is the system hitting context limits more often?)
- [ ] Latency trends over time (is the model getting slower?)

**Verification:**
- [ ] Trend API returns consistent intervals (no gaps without explanation)
- [ ] Historical data matches prior L1 snapshots
- [ ] Trend data retention defined: event-level = 30 days, aggregates = indefinite
- [ ] Memory budget defined: cap events per session (10,000 events), roll up to aggregates on overflow

### L4: Efficiency Ratios
- [ ] `tokens_in_user / tokens_out` — how much user context is needed per unit of output? (excludes system prompt overhead)
- [ ] `tokens_saved vs. baseline` — what would this have cost without optimization?
- [ ] `cost_per_successful_task` — cost divided by success count
- [ ] `system_overhead_pct` — what percentage of input tokens are system prompt (fixed cost)? Enables optimization of system prompts.
- [ ] All ratios handle division-by-zero gracefully (e.g., sessions with no output → return `null`, not `0` or `Infinity`)

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

### 4b: Tokenizer Accuracy
- [ ] Document which tokenizer is used (e.g., tiktoken `cl100k_base`)
- [ ] If model changes tokenizer, surface a footnote or flag
- [ ] Test: compare counted tokens against model API's reported `usage` field — delta should be <1%
- [ ] When model API doesn't report usage (self-hosted), set `token_count_source: "estimated"` and document the estimation method
- [ ] **If delta > 1%:** log a warning, use API-reported count as truth, flag in response `meta.token_count_reconciliation_issue: true`

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
    "cost_estimate_usd": "0.42",
    "cost_unavailable": false,
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
- [ ] Wire up aggregation pipelines (L1→L2→L3→L4)
- [ ] Use atomic increments for L1/L2 in-memory counters (thread-safe)
- [ ] Implement idempotent upsert on `event_id` for deduplication
- [ ] Implement rollup for sessions exceeding 10,000 events
- [ ] Implement auto-close for orphaned sessions (timeout-based)
- [ ] Set `session_status: "orphaned"` for sessions that crash without cleanup

### Cost Alerting
- [ ] Define alert thresholds: cost spike (e.g., >3x daily average), runaway session (e.g., >$10/session), abnormal retry rate (>20%)
- [ ] Alert channels: log, webhook, or notification — configurable per tenant
- [ ] Alert on `token_count_reconciliation_issue: true` (local count diverges from API count by >1%)

### API
- [ ] Add `get_token_stats()` API / tool
- [ ] Add periodic auto-summary at session end
- [ ] Enforce tenant isolation on all stats endpoints
- [ ] Rate-limit stats API to prevent bulk enumeration
- [ ] Return `cost_estimate_usd` as string, never float

### Schema Evolution
- [ ] Consumers must check `schema_version` before parsing — fail gracefully on unknown versions
- [ ] Add new fields as optional (never remove or rename existing fields in the same version)
- [ ] Bump `schema_version` only when making breaking changes (field removal/rename/type change)
- [ ] Write migration guide for each version bump

### Documentation
- [ ] Document what each field means (plain-english explanations)
- [ ] Document baseline methodology for `tokens_saved` metrics
- [ ] Document tokenizer used per model
- [ ] Document privacy guarantees (what we collect and don't)
- [ ] Add disclaimer about model-specific baselines and cross-model comparisons
- [ ] Document `schema_version` evolution policy
- [ ] Document why `cost_estimate_usd` is a string (avoiding float bugs)

### Testing
- [ ] Write tests for each aggregation layer (L1–L4)
- [ ] Write tests for privacy guarantees (no content in stats, no cross-tenant leakage)
- [ ] Write tests for edge cases: null token counts, partial streams, retries, missing pricing
- [ ] Write tests for division-by-zero in efficiency ratios
- [ ] Write test: `cost_estimate_cents` is always an integer, never a float
- [ ] Write test: `cost_estimate_usd` in response is always a string, never a float
- [ ] Write test: concurrent events don't double-count (atomic counter test)
- [ ] Write test: duplicate `event_id` is deduped (idempotent upsert)
- [ ] Write test: L2 totals across tools == L1 session totals (cross-check)
- [ ] Write test: `tokens_in_system` + `tokens_in_user` + `tokens_in_cached` is consistent across L1/L2/L3
- [ ] Write load test: benchmark p99 latency overhead of stats pipeline (<1ms target)
- [ ] Write integration test: send real LLM call, verify event is emitted correctly

### Rollout
- [ ] Dogfood internally before external release
- [ ] Monitor orphaned session rate and auto-close effectiveness
- [ ] Monitor stats pipeline latency (p99 < 1ms on hot path)
- [ ] Monitor cost alert false-positive rate (tune thresholds)
- [ ] Collect feedback on suggestion quality — are recommendations actually useful?
- [ ] Verify token count reconciliation: local count vs. API-reported count delta < 1% in production

---

## Progress Tracker

| Step | Status | Blocker |
|------|--------|---------|
| 1. Privacy (content leakage) | 🔲 Not started | — |
| 1. Privacy (inference attacks) | 🔲 Not started | — |
| 1. Privacy (access control) | 🔲 Not started | — |
| 1. Privacy (retention & erasure) | 🔲 Not started | — |
| 2. Data Model | 🔲 Not started | Depends on Step 1 |
| 2. Concurrency model | 🔲 Not started | Depends on Step 2 schema |
| 3. L1 Totals | 🔲 Not started | Depends on Step 2 |
| 3. L2 Breakdown | 🔲 Not started | Depends on L1 |
| 3. L3 Trends | 🔲 Not started | Depends on L2 |
| 3. L4 Ratios | 🔲 Not started | Depends on L2 |
| 4. Caveats & Safeguards | 🔲 Not started | Integrates with Steps 2–3 |
| 5. Output Format & API | 🔲 Not started | Depends on Steps 2–4 |
| 6. Integration & Rollout | 🔲 Not started | Depends on all above |

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

## Appendix B: Token Count Reconciliation Protocol

When local token counts diverge from API-reported counts:
1. **Always use API-reported counts as truth** when available (`token_count_source: "api_reported"`)
2. **If delta > 1%:** log a warning with both counts, set `meta.token_count_reconciliation_issue: true`
3. **If API doesn't report counts:** set `token_count_source: "estimated"`, document the estimation method
4. **If estimation is impossible:** set `token_count_source: "unavailable"`, leave counts as `null` (not `0`)
5. **Never silently override API counts with local estimates**

## Appendix C: Session Lifecycle

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

*Last updated: After second review — bug fixes (float→cents, concurrency, system prompt split, latency, schema versioning, alerting, reconciliation, session lifecycle) integrated*