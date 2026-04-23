# Aelvyril PII Detection Benchmark Methodology

> Full documentation of the evaluation methodology, metrics, datasets, and reproducibility procedures.

**Version:** 1.0
**Last Updated:** 2026-04-20
**Primary Metric:** F₂ score (β=2, recall-weighted)

---

## Table of Contents

1. [Overview](#overview)
2. [Metrics](#metrics)
3. [Datasets](#datasets)
4. [Evaluation Pipeline](#evaluation-pipeline)
5. [Benchmark Phases](#benchmark-phases)
6. [Reproducibility](#reproducibility)
7. [Statistical Significance](#statistical-significance)
8. [Limitations](#limitations)

---

## Overview

Aelvyril's PII detection benchmarks are designed to establish **credible, reproducible, publishable** accuracy metrics. The evaluation philosophy prioritizes **recall** over precision — in Aelvyril's threat model, missing PII (false negative) is significantly worse than over-redacting (false positive).

### Design Principles

1. **Production-path evaluation:** All benchmarks call the live HTTP endpoint, measuring real-world accuracy including retry logic, overlap resolution, and confidence scoring — not isolated component performance.
2. **Recall-weighted primary metric:** F₂ (β=2) weights recall 4× over precision, reflecting the threat model.
3. **Multi-framework validation:** Results are cross-validated across multiple independent benchmark frameworks (Presidio-Research, PII-Bench, TAB, ai4privacy).
4. **Full reproducibility:** Fixed seeds, pinned dependencies, environment capture, and cache clearing ensure bit-exact reproducibility.

---

## Metrics

### F₂ Score (Primary)

```
F₂ = (1 + β²) × (Precision × Recall) / (β² × Precision + Recall)
where β = 2
```

F₂ weights recall 4× over precision. A system with 95% recall and 90% precision scores F₂ = 0.93, while the reverse (90% recall, 95% precision) scores only F₂ = 0.91.

### F₁ Score

Standard harmonic mean of precision and recall. Used for comparison with published baselines that report F₁.

### Strict-F1 (PII-Bench)

Exact span match: predicted span start/end must match gold exactly. No partial credit.

### Entity-F1 (PII-Bench)

Token-level F1 with BIO tagging. Partial span overlap is rewarded proportionally.

### RougeL-F (PII-Bench)

Longest Common Subsequence (LCS) based fuzzy matching. A match is counted if Rouge-L F-measure ≥ 0.5.

### R_direct / R_quasi (TAB)

Recall of DIRECT identifiers (must mask: names, SSNs) and QUASI identifiers (should mask: dates, locations). Measures anonymization quality beyond detection.

### Robustness Score (Adversarial)

```
robustness = detection_rate(adversarial_input) / detection_rate(clean_input)
```

1.0 = no degradation under adversarial input. <0.5 = significant evasion risk.

---

## Datasets

### Phase 1: Presidio-Research Synthetic Data

- **Source:** Generated in-house using Faker with LLM-prompt templates
- **Size:** 1,000+ samples (configurable)
- **Entity Types:** EMAIL_ADDRESS, PHONE_NUMBER, US_SSN, CREDIT_CARD, IBAN_CODE, IP_ADDRESS, PERSON, LOCATION, ORGANIZATION, DATE_TIME, US_ZIP_CODE, API_KEY, Domain
- **Format:** JSON — `{"text": "...", "spans": [{"entity_type", "start", "end", "text"}]}`

### Phase 2: PII-Bench (Fudan)

- **Source:** arxiv:2502.18545, GitHub: THU-MIG/PII-Bench
- **Size:** 2,842 samples
- **Splits:** pii_single, pii_multi, pii_hard, pii_distract
- **Entity Types:** person_name, phone_number, email_address, id_card_number, bank_account_number, location, date_time
- **License:** Research use

### Phase 2: TAB (Text Anonymization Benchmark)

- **Source:** NorskRegnesentral/text-anonymization-benchmark
- **Size:** 1,268 ECHR court cases
- **Entity Types:** PERSON, ORG, LOC, DATETIME, CODE, DEM
- **Masking Categories:** DIRECT (must mask), QUASI (should mask), NO_MASK (keep)
- **License:** MIT

### Phase 3: DataFog PII-NER

- **Source:** HuggingFace: datafog/pii-ner
- **Size:** 500 generated test samples (shared with Aelvyril evaluation)
- **License:** Apache 2.0

### Phase 3: ai4privacy/open-pii-masking-500k

- **Source:** HuggingFace: ai4privacy/open-pii-masking-500k
- **Size:** 500,000+ samples (evaluated on 2,000 English subset)
- **Entity Types:** 20+ including FIRSTNAME, LASTNAME, EMAIL, PHONENUMBER, CREDITCARDNUMBER, IBAN, SSN, IPADDRESS, etc.
- **License:** Apache 2.0

### Phase 3: Adversarial Test Suite

- **Source:** Generated in-house
- **Size:** ~120+ test cases across 7 categories
- **Categories:** homoglyph, zero_width, base64, leet, separator, edge_case, bulk
- **Edge Cases:** Short text, code context, JSON blobs, nested entities, partial redaction

---

## Evaluation Pipeline

### Architecture

```
┌──────────────┐     HTTP POST      ┌──────────────────┐
│   Benchmark   │ ──────────────────→ │  Aelvyril /analyze │
│   Runner      │   {text, language} │  (localhost:3000)  │
│   (run.py)    │ ←────────────────── │                    │
│               │   [{entity_type,   │  ┌──────────────┐  │
│               │     start, end,    │  │ Presidio     │  │
│               │     score}]        │  │ Custom REs   │  │
└──────────────┘                     │  │ Overlap Res  │  │
       │                             │  │ Conf Scoring │  │
       ▼                             │  └──────────────┘  │
┌──────────────┐                     └──────────────────┘
│   Metrics     │
│   Computation │  F₂, Strict-F1, Entity-F1, RougeL-F
│   (common/)   │  R_direct, R_quasi, Robustness
└──────────────┘
       │
       ▼
┌──────────────┐
│   Reporting   │  Markdown, JSON, Dashboard
│   (reporting) │
└──────────────┘
```

### Service Requirement

All benchmarks (except data generation and adversarial test generation) require a running Aelvyril service with Presidio active:

```bash
docker compose -f benchmarks/docker-compose.bench.yml up -d
```

The evaluator validates service health before starting and invalidates runs with >1% call failure rate.

### Entity Type Mapping

Aelvyril uses a unified entity type system. Benchmarks map their native types through:

| Benchmark Native | Aelvyril Type |
|-----------------|---------------|
| EMAIL_ADDRESS, EMAIL | Email |
| PHONE_NUMBER, PHONENUMBER | Phone |
| US_SSN, SOCIALNUM, SSN | SSN |
| CREDIT_CARD, CREDITCARDNUMBER | Credit_Card |
| IBAN_CODE, IBAN, BANKACCOUNTNUM | IBAN |
| IP_ADDRESS, IPADDRESS | IP_Address |
| PERSON, PER, FIRSTNAME, LASTNAME | Person |
| LOCATION, LOC, CITY, ADDRESS | Location |
| ORGANIZATION, ORG, COMPANY | Organization |
| API_KEY, PASSWORD | API_Key |
| DOMAIN_NAME, URL | Domain |
| DATE_TIME, DATEOFBIRTH, DATETIME | Date |
| US_ZIP_CODE, ZIPCODE | Zip_Code |

---

## Benchmark Phases

### Phase 1: Quick Wins (Presidio-Research)

**Purpose:** Immediate baseline numbers.

1. Generate 1,000+ synthetic LLM-prompt samples
2. Run vanilla Presidio baseline
3. Run Aelvyril pipeline
4. Compare per-entity F₂ scores

**Output:** `F2_AELVYRIL.md`

### Phase 2: Academic Credibility (PII-Bench + TAB)

**Purpose:** Comparison against published academic results.

1. PII-Bench: Strict-F1, Entity-F1, RougeL-F vs GPT-4o/DeepSeek/Claude
2. TAB: R_direct, R_quasi, re-identification risk assessment
3. Cross-benchmark comparison matrix
4. Statistical significance via bootstrap resampling (10k iterations)
5. Error analysis: FP/FN breakdown, confusion matrices

**Output:** `BENCHMARK_RESULTS.md`, `TAB_ANONYMIZATION_REPORT.md`, `ERROR_ANALYSIS.md`

### Phase 3: Publication-Ready (Supplementary + Dashboard)

**Purpose:** Full transparency with per-entity comparison tables.

1. DataFog PII-NER head-to-head: F₁ comparison against open-source model
2. ai4privacy large-scale validation: 2,000 sample subset
3. Adversarial robustness: 7 obfuscation categories + edge cases
4. Benchmark dashboard: auto-generated comparison tables
5. Methodology documentation

**Output:** `BENCHMARK_COMPARISON.md`, `DATAFOG_COMPARISON.md`, `AI4PRIVACY_REPORT.md`, `ADVERSARIAL_REPORT.md`

---

## Reproducibility

### Fixed Seeds

All random operations use `seed=42`:

```python
random.seed(42)
np.random.seed(42)
Faker.seed(42)
```

### Version Pinning

All dependencies are pinned in `benchmarks/versions.lock`:
- Dataset SHA or release tag
- Python version and pip freeze
- Rust toolchain version
- Model weights hash

### Cache Clearing

Aelvyril's detection cache (`cache.rs`, SHA-256 keyed) must be cleared before each run. The benchmark runner supports `--clear-cache`.

### Environment Capture

Each run writes a `run_manifest.json`:

```json
{
  "aelvyril_version": "1.2.3",
  "python_version": "3.11.8",
  "platform": "linux-x86_64",
  "seed": 42,
  "timestamp": "2026-04-20T10:00:00Z"
}
```

---

## Statistical Significance

All Phase 2+ results include 95% confidence intervals via **non-parametric bootstrap resampling** (10,000 iterations).

### Why Bootstrap (Not t-test)?

Benchmark samples are NOT independent — the same PII types appear in multiple samples, and detection accuracy is correlated within entity types. Bootstrap resampling is distribution-free and handles this correctly.

### Method

1. Resample N per-sample results WITH replacement
2. Recompute the aggregate metric
3. Repeat 10,000 times
4. Take 2.5th and 97.5th percentiles as 95% CI

### Reporting

Results include:
- Observed value
- Bootstrap mean and standard deviation
- 95% CI [lower, upper]
- CI width (narrower = more precise)

---

## Limitations

1. **English-only:** Current benchmarks evaluate English (en_US) only. Cross-lingual evaluation (de_DE, fr_FR, es_MX) is deferred to a future phase.
2. **Service dependency:** Requires live Aelvyril + Presidio stack. Offline evaluation is not supported.
3. **Synthetic data bias:** Phase 1 uses Faker-generated data which may not represent real-world PII distribution.
4. **NER model dependency:** Person, Location, and Organization detection relies on Presidio's NER backend (spaCy/transformers). Performance depends on the specific model used.
5. **Adversarial test coverage:** The adversarial test suite covers common obfuscation techniques but is not exhaustive.
6. **API Key/Domain/Date/ZipCode:** These Aelvyril-specific types are not present in standard academic benchmarks and are evaluated with synthetic data only.

---

## Appendix: Metric Formulas

**Fβ Score:**
```
Fβ = (1 + β²) × (P × R) / (β² × P + R)
```

**Strict-F1:**
```
TP if entity_type matches AND |pred.start - gold.start| ≤ tolerance AND |pred.end - gold.end| ≤ tolerance
```

**Entity-F1 (Token-level BIO):**
```
Convert spans → BIO tags → compute token-level F1
```

**RougeL-F:**
```
RougeL-F = 2 × LCS_precision × LCS_recall / (LCS_precision + LCS_recall)
Match if RougeL-F ≥ 0.5
```

**IoU (Intersection over Union):**
```
IoU = intersection(pred, gold) / union(pred, gold)
Match if IoU ≥ threshold (default: 0.5)
```

---

*Methodology Version: 1.0*
*Review: Aligned with PiiBenchmarkPlan.md v1.2*
