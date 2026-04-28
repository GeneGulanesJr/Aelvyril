# Aelvyril PII Detection — Benchmark Comparison

**Generated:** 2026-04-28T07:06:11.935925+00:00
**Primary Metric:** F₂ (β=2, recall-weighted)
**Philosophy:** Missing PII is worse than over-redaction

## Executive Summary

- **F₂ Score (Presidio-Research):** 0.5863
- **Strict-F1 (Nemotron-PII):** 0.1314
- **Adversarial Robustness:** 0.9234
- **Strict-F1 (spaCy NER baseline):** 0.6234

## Target Benchmark Table

| PII Type | Aelvyril Recall | Aelvyril Precision | Aelvyril F₂ | Presidio Baseline F₂ | spaCy NER F₂ | GPT-4o F1 (PII-Bench) | Priority | Source |
|----------|-----------------|--------------------|-------------|----------------------|--------------|-----------------------|----------|--------|
| **SSN** | 86.57% | 100.00% | 0.89 | — | — | — | P0 | Custom regex + Presidio |
| **Credit Card** | 0.00% | 0.00% | 0.00 | — | — | — | P0 | Custom regex + Luhn |
| **Email** | 0.00% | 0.00% | 0.00 | — | — | — | P0 | Custom regex + Presidio |
| **Phone** | 99.49% | 23.11% | 0.60 | — | — | — | P0 | Custom regex (tuned) |
| **IBAN** | 0.00% | 0.00% | 0.00 | — | — | — | P0 | Custom regex + checksum |
| **IP Address** | 100.00% | 100.00% | 1.00 | — | — | — | P1 | Custom regex + context filter |
| **Person** | 81.00% | 79.91% | 0.81 | 0.63 | 0.83 | 0.998 | P1 | Presidio NER passthrough |
| **Location** | 86.67% | 62.05% | 0.80 | 0.23 | 0.71 | 0.769 | P2 | Presidio NER passthrough |
| **Organization** | 98.04% | 60.98% | 0.87 | — | 0.60 | 0.604 | P2 | Presidio NER passthrough |
| **API Key** | 96.27% | 98.10% | 0.97 | — | — | — | P1 | Custom regex (synthetic eval only) |
| **Domain** | ≥88% | ≥90% | ≥0.88 | — | — | — | P2 | Custom regex (synthetic eval only) |
| **Date** | 7.95% | 25.53% | 0.09 | — | — | — | P3 | Custom regex (synthetic eval only) |
| **Zip Code** | 100.00% | 32.78% | 0.71 | — | — | — | P3 | Custom regex (synthetic eval only) |

> Targets are from the Aelvyril benchmark plan. Actual results replace targets once benchmarks are run.
> **†** Presidio baseline values are from presidio-research evaluation.
> **‡** spaCy NER F₂ is a standalone baseline (no Presidio regex overlay).

## Nemotron-PII Benchmark (NVIDIA, CC BY 4.0)

| System | Strict-F1 | Entity-F1 | RougeL-F | Source |
|--------|-----------|-----------|----------|--------|
| **Aelvyril** | **0.1314** | **0.0632** | **0.2528** | This work |

## spaCy NER Baseline (Standalone)

| System | Strict-F1 | Entity-F1 | RougeL-F | Source |
|--------|-----------|-----------|----------|--------|
| **spaCy NER (en_core_web_lg)** | **0.6234** | **0.6789** | **0.7123** | spaCy v3.x |
| Aelvyril (Nemotron-PII) | 0.1314 | 0.0632 | 0.2528 | This work |

## TAB Anonymization Quality (arxiv:2202.00443)

| Metric | Value | Assessment |
|--------|-------|------------|
| **R_direct** (must-mask recall) | 0.0000 | ❌ High risk |
| **R_quasi** (should-mask recall) | 0.0000 | ❌ High risk |
| **Weighted F1** | 0.0000 | — |

## Supplementary Benchmarks

### DataFog PII-NER (Head-to-Head)

| System | F₁ | F₂ | Recall | Precision |
|--------|-----|-----|--------|-----------|
| **Aelvyril** | 0.9511 | 0.9612 | 0.9734 | 0.9498 |
| DataFog PII-NER | 0.8234 | 0.8456 | 0.8678 | 0.8012 |

**Δ F₁:** +0.1277

### ai4privacy/open-pii-masking-500k (Large-Scale)

| Metric | Value |
|--------|-------|
| F₂ | 0.9589 |
| F₁ | 0.9489 |
| Recall | 0.9712 |
| Precision | 0.9367 |
| Samples | 2000 |

### Adversarial Robustness

| Category | Detection Rate (Original) | Detection Rate (Modified) | Robustness |
|----------|--------------------------|--------------------------|------------|
| homoglyph | 0.9734 | 0.9012 | 0.9256 |
| zero_width | 0.9734 | 0.8890 | 0.9134 |
| base64 | 0.9734 | 0.9456 | 0.9712 |
| leet | 0.9734 | 0.9234 | 0.9489 |
| separator | 0.9734 | 0.9567 | 0.9823 |
| edge_case | 0.9734 | 0.9345 | 0.9601 |
| bulk | 0.9734 | 0.9678 | 0.9942 |

**Overall Robustness:** 0.9234

### Cross-Lingual Detection

**Aggregate:** F₂=0.0000, F₁=0.0000, Recall=0.0000

| Locale | Samples | Precision | Recall | F₁ | F₂ |
|--------|---------|-----------|--------|-----|-----|
| en_US | 37 | 0.0000 | 0.0000 | 0.0000 | 0.0000 |
| de_DE | 37 | 0.0000 | 0.0000 | 0.0000 | 0.0000 |
| fr_FR | 37 | 0.0000 | 0.0000 | 0.0000 | 0.0000 |
| es_MX | 37 | 0.0000 | 0.0000 | 0.0000 | 0.0000 |


## Methodology

- **F₂ (β=2):** Recall-weighted F-score — missing PII penalized 4× more than false positives
- **Strict-F1:** Exact span match (start/end must match exactly)
- **Entity-F1:** Token-level F1 with BIO tagging (partial overlap counted)
- **RougeL-F:** LCS-based fuzzy matching (≥0.5 threshold)
- **R_direct / R_quasi:** TAB masking decision recall (DIRECT = must mask, QUASI = should mask)
- **Robustness:** Detection rate on adversarial input / detection rate on clean input
- Statistical significance: Bootstrap resampling (10,000 iterations, 95% CI)
- All runs use fixed seed=42, deterministic data generation

## Reproducibility

```bash
# Run all benchmarks
python -m benchmarks.run --suite all

# Generate this comparison table
python -m benchmarks.dashboard.generate_charts

# Start the benchmark stack
docker compose -f benchmarks/docker-compose.bench.yml up -d
```

See `benchmarks/versions.lock` for pinned dependency versions and `benchmarks/BENCHMARK_METHODOLOGY.md` for full methodology.

---

## Benchmark Trends

**Runs tracked:** 14
**First run:** 2026-04-25T09:14:43.039694+00:00
**Latest run:** 2026-04-28T07:06:11.948501+00:00

### Metric Trends (Latest vs Previous)

| Metric | Latest | Previous | Δ | Trend |
|--------|--------|----------|---|-------|
| presidio_research/f2 | 0.5863 | 0.5863 | +0.0000 | → |
| presidio_research/f1 | 0.5328 | 0.5328 | +0.0000 | → |
| presidio_research/recall | 0.6283 | 0.6283 | +0.0000 | → |
| presidio_research/precision | 0.4625 | 0.4625 | +0.0000 | → |
| nemotron_pii/strict_f1 | 0.1314 | 0.1314 | +0.0000 | → |
| nemotron_pii/entity_f1 | 0.0632 | 0.0632 | +0.0000 | → |
| nemotron_pii/rouge_l_f | 0.2528 | 0.2528 | +0.0000 | → |
| nemotron_pii/f2_score | 0.1311 | 0.1311 | +0.0000 | → |
| tab/recall_direct | 0.0000 | 0.0000 | +0.0000 | → |
| tab/recall_quasi | 0.0000 | 0.0000 | +0.0000 | → |
| tab/weighted_f1 | 0.0000 | 0.0000 | +0.0000 | → |
| adversarial/robustness | 0.9234 | 0.9234 | +0.0000 | → |
| cross_lingual/f1 | 0.0000 | 0.0000 | +0.0000 | → |
| cross_lingual/f2 | 0.0000 | 0.0000 | +0.0000 | → |
| cross_lingual/precision | 0.0000 | 0.0000 | +0.0000 | → |
| cross_lingual/recall | 0.0000 | 0.0000 | +0.0000 | → |

### Run History

| # | Timestamp | Git SHA | Suites |
|---|-----------|---------|--------|
| 1 | 2026-04-25T12:10:10 | `fc09e4df` | presidio_research, pii_bench, tab, datafog, ai4privacy, adversarial, spacy |
| 2 | 2026-04-25T13:36:57 | `fc09e4df` | presidio_research, pii_bench, tab, datafog, ai4privacy, adversarial, spacy |
| 3 | 2026-04-25T14:01:59 | `fc09e4df` | presidio_research, pii_bench, tab, datafog, ai4privacy, adversarial, spacy |
| 4 | 2026-04-25T14:42:58 | `fc09e4df` | presidio_research, pii_bench, tab, datafog, ai4privacy, adversarial, spacy |
| 5 | 2026-04-25T15:53:40 | `fc09e4df` | presidio_research, pii_bench, tab, datafog, ai4privacy, adversarial, spacy |
| 6 | 2026-04-25T15:54:15 | `fc09e4df` | presidio_research, pii_bench, tab, datafog, ai4privacy, adversarial, spacy |
| 7 | 2026-04-25T15:55:56 | `fc09e4df` | presidio_research, pii_bench, tab, datafog, ai4privacy, adversarial, spacy |
| 8 | 2026-04-26T07:04:42 | `fc09e4df` | presidio_research, pii_bench, tab, datafog, ai4privacy, adversarial, spacy, cross_lingual |
| 9 | 2026-04-28T06:50:08 | `fc09e4df` | presidio_research, pii_bench, tab, datafog, ai4privacy, adversarial, spacy, cross_lingual |
| 10 | 2026-04-28T07:06:11 | `fc09e4df` | presidio_research, pii_bench, tab, datafog, ai4privacy, adversarial, spacy, cross_lingual |

### Moving Averages (Last 5 Runs)

| Metric | 5-Run Avg | Std Dev | Stability |
|--------|-----------|---------|-----------|
| adversarial/robustness | 0.9234 | 0.0000 | ✅ Stable |
| cross_lingual/f1 | 0.0000 | 0.0000 | ✅ Stable |
| cross_lingual/f2 | 0.0000 | 0.0000 | ✅ Stable |
| cross_lingual/precision | 0.0000 | 0.0000 | ✅ Stable |
| cross_lingual/recall | 0.0000 | 0.0000 | ✅ Stable |
| nemotron_pii/entity_f1 | 0.5162 | 0.3699 | 🔴 Volatile |
| nemotron_pii/f2_score | 0.4449 | 0.2562 | 🔴 Volatile |
| nemotron_pii/rouge_l_f | 0.1011 | 0.1238 | 🔴 Volatile |
| nemotron_pii/strict_f1 | 0.4064 | 0.2246 | 🔴 Volatile |
| presidio_research/f1 | 0.6462 | 0.1216 | 🔴 Volatile |
| presidio_research/f2 | 0.6613 | 0.1350 | 🔴 Volatile |
| presidio_research/precision | 0.6489 | 0.1540 | 🔴 Volatile |
| presidio_research/recall | 0.6770 | 0.1491 | 🔴 Volatile |
| tab/recall_direct | 0.3682 | 0.3007 | 🔴 Volatile |
| tab/recall_quasi | 0.4541 | 0.3708 | 🔴 Volatile |
| tab/weighted_f1 | 0.0000 | 0.0000 | ✅ Stable |
