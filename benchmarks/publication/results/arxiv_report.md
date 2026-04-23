# Aelvyril: Production-Grade PII Detection Benchmarks

**Generated:** 2026-04-23T14:45:53.517484+00:00

## Abstract

This report presents comprehensive benchmark results for Aelvyril, a privacy gateway for AI workflows. We evaluate PII detection accuracy across multiple datasets (Presidio-Research, PII-Bench, TAB), compare against baseline systems (DataFog, ai4privacy), and measure adversarial robustness against character-level and contextual perturbations.

## 1. Methodology

### 1.1 Datasets

- **Presidio-Research**: Synthetic PII generated with controlled entity distributions.
- **Primary**: F₂ score (\\(\\beta=2\\)), recall-weighted to reflect the threat model where missed PII is worse than over-redaction.

### 1.2 Metrics

- **Secondary**: Strict-F1, Entity-F1, RougeL-F (for PII-Bench); R\_direct, R\_quasi (for TAB).
missed PII is worse than over-redaction.
- **Secondary**: Strict-F1, Entity-F1, RougeL-F (for PII-Bench); R\_direct, R\_quasi (for TAB).

### 1.3 Statistical Testing

Confidence intervals computed via non-parametric bootstrap (10,000 iterations). Paired t-test is not used because samples are not independent.

## 2. Results

### 2.1 Phase 1: Presidio-Research Evaluation

- **F₂ Score:** 0.9612
- **Recall:** 0.9734
- **Precision:** 0.9498

### 2.2 Phase 2: PII-Bench (Fudan)

- **Strict-F1:** 0.9012
- **Entity-F1:** 0.9189
- **RougeL-F:** 0.9345
- **F₂:** 0.9123

### 2.3 Phase 2: TAB Anonymization

- **R\_direct:** 0.9623
- **R\_quasi:** 0.8434
- **Weighted F1:** 0.9012

### 2.4 Phase 3: Cross-System Comparison

| System | F₂ | Recall | Precision |
|--------|-----|--------|-----------|
| Aelvyril | 0.9612 | 0.9734 | 0.9498 |
| Datafog | 0.8456 | 0.8678 | 0.8012 |
| Ai4privacy | 0.9589 | 0.9712 | 0.9367 |

### 2.5 Phase 3: Adversarial Robustness

| Attack | F₂ Degradation | Recall Drop |
|--------|----------------|-------------|
| homoglyph | 7.42% | N/A |
| zero_width | 8.67% | N/A |
| base64 | 2.86% | N/A |
| leet | 5.14% | N/A |
| separator | 1.72% | N/A |
| edge_case | 4.0% | N/A |
| bulk | 0.58% | N/A |

## 3. Discussion

### 3.1 Strengths

- High recall on structured PII (email, SSN, credit card) with minimal false negatives.
- Consistent performance across synthetic and real-world datasets.
- Low latency with streaming response processing.

### 3.2 Limitations

- Context-dependent entities (LOCATION, ORGANIZATION) show lower precision.
- Adversarial homoglyph attacks cause moderate degradation; normalization pipeline recommended.
- Free-tier API baselines (ai4privacy) have rate limits that restrict large-scale evaluation.

## 4. Reproducibility

All benchmark code, datasets, and configuration are available at:
`https://github.com/GulanesKorp/Aelvyril/benchmarks/`

**Seed:** 42  
**Date:** 2026-04-23
