# Token Usage Statistics — User Guide

**Document version:** 1.0  
**Last updated:** 2026-04-24  
**Applies to:** Aelvyril v0.x

---

## Quick Start

Open the Aelvyril dashboard. Token usage cards appear automatically once LLM calls flow through the gateway:

- **Tokens In** — total input tokens (system + user + cached)
- **Tokens Out** — total completion tokens generated
- **Est. Cost** — running cost estimate in USD (integer cents internally, no float bugs)

If cost shows as "unavailable," the model isn't in the pricing table yet. The system still tracks tokens; cost catches up when pricing is added.

---

## What Gets Tracked

For every LLM call, Aelvyril records **numbers only**:

| Metric | What it means |
|--------|--------------|
| `tokens_in_system` | System prompt overhead (you can't control this) |
| `tokens_in_user` | Your actual prompt / context tokens |
| `tokens_in_cached` | Cached prompt tokens (discounted rate) |
| `tokens_in_cache_write` | Cache-write tokens (premium rate, e.g., Anthropic) |
| `tokens_out` | Completion tokens the model generated |
| `tokens_truncated` | Tokens lost because they hit the context window limit |
| `duration_ms` | Wall-clock time from request to full response |
| `cost_estimate_cents` | Estimated cost based on token counts × pricing table |
| `actual_cost_cents` | Provider-reported cost, when available (preferred) |

**Nothing else.** No prompts, no responses, no file contents, no PII. See `TOKEN_USAGE_PRIVACY.md` for the full disclosure.

---

## Reading the Dashboard

### Stat Cards

The dashboard shows aggregate cards:

- **Total Requests** — all gateway requests (not just LLM calls)
- **Active Sessions** — open conversation contexts
- **Tokens In / Tokens Out** — raw token volume
- **Est. Cost** — cumulative estimated cost since app start

### Trends

The dashboard includes sparklines (mini charts) showing recent activity. For full trend data, use the **Trends** view:

- Daily token volume
- Daily cost
- Truncation rate over time
- Latency trends (p50 / p99)

A rising truncation rate means you're hitting context limits more often — consider breaking tasks into smaller steps.

---

## Understanding Suggestions

The system generates contextual suggestions based on your usage patterns:

| Condition | Suggestion |
|-----------|-----------|
| Truncation rate > 5% | "You hit context limits frequently. Break tasks into smaller steps." |
| System overhead > 30% | "A large portion of input is system prompt. Consider optimizing it." |
| Tokens saved > 10% | "Good efficiency — targeted retrieval is saving tokens vs. full-file reads." |
| High retry rate | "Many calls are retried. Check provider stability or timeout settings." |

**Important:** Lower tokens ≠ automatically better. Always check `success_rate` alongside efficiency metrics. A cheap failed call is worse than an expensive successful one.

---

## Access Levels

Stats responses include `meta.access_level` so you know what detail you're seeing:

| Level | What you see | Who |
|-------|-------------|-----|
| `full` | Per-tool, per-model, per-call detail, full cost | Admin / owner |
| `summary` | Aggregated totals only, no breakdown | Standard user |
| `redacted` | Tool names hidden, no cost detail | External / shared views |

Aelvyril is single-tenant by default, so most users see `full`.

---

## Sessions

A **session** is a group of LLM calls tied to one conversation context. Sessions have three states:

- **Active** — ongoing, events being recorded
- **Closed** — ended normally (user ended chat or task completed)
- **Orphaned** — crashed or timed out after 30 minutes of inactivity

Orphaned sessions are auto-closed by a background task. You can also trigger cleanup manually from **Settings → Token Usage → Cleanup Orphans**.

### Session-Level Stats

Drill into a session to see:

- Total tokens and cost for that conversation
- Which tools consumed the most tokens
- Which models were used
- Success rate, retry rate, partial rate
- Latency profile (avg / p50 / p99)

---

## Efficiency Metrics (L4)

These ratios help you understand whether you're using tokens effectively:

| Metric | Formula | Interpretation |
|--------|---------|----------------|
| `context_to_output_ratio` | `tokens_in_user / tokens_out` | How much context you need per unit of output. Lower is generally better. |
| `system_overhead_pct` | `tokens_in_system / total_input` | What % of input is system prompt. You can't control this directly, but high values (>30%) may indicate a bloated system prompt. |
| `cost_per_successful_task` | `cost / success_count` | Average cost of a successful call. Useful for budgeting. |
| `tokens_saved_pct` | `cached_tokens / total_input` | Approximate savings from caching and targeted retrieval. |
| `tokens_per_active_day` | `total_tokens / active_days` | Normalizes for usage patterns. 10K tokens in one day vs. spread over a month tell different stories. |
| `quality_score` | Composite of success rate, low retry rate, low truncation rate | 0.0–1.0. Higher is better. Shown alongside token stats to prevent gaming the numbers. |

---

## Cost Alerts

Aelvyril monitors for abnormal patterns and fires alerts:

| Alert | Threshold | What to do |
|-------|-----------|------------|
| Cost spike | Session cost > 3× daily average | Check if a new feature or model was deployed |
| Runaway session | Session cost > $10 | Investigate for infinite loops or retry storms |
| Abnormal retry rate | > 20% of calls retried | Check provider status page; increase timeout |
| High truncation rate | > 10% globally | Review context window management; break tasks smaller |

Alerts appear in the app logs and can be checked manually via **Settings → Token Usage → Check Alerts**.

---

## Data Export & Deletion

### Export

You can export token stats as JSON:

1. Go to **Settings → Token Usage → Export**
2. Choose session or global export
3. Save the `.json` file

### Delete

To delete token stats for a session:

1. Go to **Settings → Token Usage → Sessions**
2. Find the session
3. Click **Delete**

**Note:** Event-level data is deleted, but daily aggregates cannot be un-rolled.

---

## Retention

| Data type | Retention | Auto-purge |
|-----------|-----------|------------|
| Event-level records | 30 days | Yes |
| Daily aggregates | Indefinite | No |
| Session totals | Indefinite | No |

Old events are purged automatically. If you need long-term event-level data, export it before the 30-day window.

---

## Troubleshooting

### Cost shows as "unavailable"

The model isn't in the pricing table. Tokens are still tracked. The estimate will appear when pricing is added (usually via LiteLLM fetch at startup).

### Stats look wrong / double-counted

Every event has a UUID (`event_id`). Duplicate events are deduplicated automatically. If you suspect corruption, reset stats from **Settings → Token Usage → Reset**.

### Orphan rate is high

Orphaned sessions happen when the client disconnects without closing the session properly. Check:

- Is the app crashing?
- Is the client closing connections abruptly?
- Consider increasing the orphan timeout in Settings

### Suggestions aren't useful

Suggestions are heuristic. You can tune thresholds in the source (`src-tauri/src/token_usage/tracker.rs`) or ignore them if they don't apply to your workflow.

---

## Privacy at a Glance

- **No content is stored.** Only token counts and metadata.
- **No PII in stats.** Session IDs are random UUIDs.
- **Timestamps are rounded to the minute.** Prevents precise correlation attacks.
- **You can delete your data.** Session-level deletion is supported.
- **Raw LLM content goes to providers under their policies.** Aelvyril's stats are separate from that pipeline.

For the full privacy disclosure, see `TOKEN_USAGE_PRIVACY.md`.

---

## Glossary

| Term | Meaning |
|------|---------|
| **L1** | Per-session totals |
| **L2** | Per-tool or per-model breakdown |
| **L3** | Daily / weekly trend data |
| **L4** | Efficiency ratios and suggestions |
| **Token** | A unit of text processed by the LLM (roughly 0.75 words for English) |
| **Truncation** | When the model discards part of the context because it exceeds the window limit |
| **Cache-write** | Writing to prompt cache (typically more expensive than fresh input) |
| **Cache-read** | Reading from prompt cache (typically cheaper than fresh input) |
| **Orphaned session** | A session that timed out or crashed without being closed |
