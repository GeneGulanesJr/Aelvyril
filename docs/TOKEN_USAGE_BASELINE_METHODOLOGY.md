# Token Usage Baseline Methodology

**Document version:** 1.0  
**Last updated:** 2026-04-23  
**Applies to:** `tokens_saved_*` metrics in `EfficiencyMetrics` and `SessionTokenStats`

---

## Why Baselines Matter

The `tokens_saved_vs_baseline` metric is only meaningful with a **documented, reproducible baseline**. Without this, the metric is a vanity number that can be gamed or misunderstood.

> **Rule:** Every `tokens_saved` metric must state which baseline it uses, and the baseline must be documented here.

---

## Defined Baselines

### 1. Full-File-Read Baseline

**Definition:** The cost of reading entire source files vs. using targeted retrieval (e.g., symbol search, semantic search).

**Use case:** Measures the efficiency of Aelvyril's code intelligence features.

**Calculation:**
```
tokens_saved_vs_full_file_read = tokens_full_file_read - tokens_actual
```

Where `tokens_full_file_read` is estimated as:
- Sum of all file contents that would have been read if no targeted retrieval were used
- Estimated via `file_size_bytes × 0.25` (rough bytes-to-tokens ratio)

**Limitations:**
- Assumes the user would have read the entire file. In practice, users often read only parts.
- Cross-model comparisons are invalid because different tokenizers produce different counts.
- System prompt tokens are excluded from savings (users can't control them).

**Disclaimer:** "Savings are relative to reading entire files. Your results may vary."

---

### 2. No-Cache Baseline

**Definition:** The cost of all-fresh-input vs. cached-input (measures caching benefit).

**Use case:** Measures the value of prompt caching (e.g., Anthropic's cache, OpenAI's cached input pricing).

**Calculation:**
```
tokens_saved_vs_no_cache = tokens_in_cached × (fresh_rate - cached_rate)
```

Where:
- `fresh_rate` = cost per token for fresh input
- `cached_rate` = cost per token for cached input

**Limitations:**
- Only applies to providers that support prompt caching.
- Cache hit rate depends on workload similarity across calls.
- Cache-write tokens are **more expensive** than fresh input — savings only materialize on subsequent reads.

**Disclaimer:** "Savings assume 100% cache hit rate on cached tokens. Actual savings depend on workload patterns."

---

### 3. Naive-Prompt Baseline

**Definition:** The cost of sending full conversation context every turn vs. using conversation compression/summarization.

**Use case:** Measures the efficiency of context window management in multi-turn conversations.

**Calculation:**
```
tokens_saved_vs_naive_prompt = tokens_naive_cumulative - tokens_actual_cumulative
```

Where `tokens_naive_cumulative` is the sum of all prior turns' tokens_in_user, assuming no compression.

**Limitations:**
- Hard to estimate accurately without logging every intermediate state.
- Compression quality affects output quality (not measured by token counts alone).

**Disclaimer:** "Savings measure token volume only, not output quality. Aggressive compression may degrade results."

---

## Cross-Model Comparison Rules

**Never compare `tokens_saved` across different models without noting the model difference.**

Why? Different models use different tokenizers:
- GPT-4o uses cl100k_base
- Claude uses a proprietary tokenizer
- Llama models use SentencePiece

A prompt that is 1,000 tokens on GPT-4o might be 1,200 tokens on Claude. Comparing "tokens saved" without accounting for this is misleading.

**Rule:** When comparing across models, normalize by cost (cents) rather than token count, and always note the model pair.

---

## System Prompt Handling

System prompt tokens (`tokens_in_system`) are **excluded from savings calculations** (or called out explicitly).

Why? Users cannot control the system prompt. Claiming "savings" on tokens the user never had the option to send is dishonest.

**Rule:** `tokens_saved` metrics use `tokens_in_user` as the numerator, not `tokens_in_system + tokens_in_user`.

---

## Quality vs. Quantity

Lower token usage is not automatically better. A response that uses fewer tokens but fails the task is worse than a response that uses more tokens and succeeds.

**Companion metrics:**
- `success_rate` — did the task complete?
- `quality_score` (if available) — human or automated quality assessment
- `retry_rate` — did the system have to retry?

**UI guidance:** Always show `tokens_saved` alongside `success_rate`. If success drops while tokens drop, flag it.

---

## Reproducing Baselines

All baseline calculations must be reproducible:

1. **Document the formula** in this file
2. **Document the inputs** in code comments
3. **Log the intermediate values** when computing savings
4. **Version the baseline methodology** alongside the schema

---

## Version History

| Version | Date | Change |
|---------|------|--------|
| 1.0 | 2026-04-23 | Initial baselines: full-file-read, no-cache, naive-prompt |
