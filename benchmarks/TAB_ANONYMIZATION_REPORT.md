# TAB Anonymization Quality Report — Re-identification Risk Assessment

**Generated:** 2026-04-24T07:17:00Z
**Benchmark:** TAB — Text Anonymization Benchmark (arxiv:2202.00443)
**Documents:** 127 ECHR court cases
**Source:** NorskRegnesentral/text-anonymization-benchmark

## What TAB Measures

Unlike pure detection benchmarks, TAB evaluates **anonymization quality** —
whether the system correctly identifies which personally identifiable spans
**need to be masked** to prevent re-identification.

- **DIRECT identifiers**: Must be masked (names, SSNs, direct identifiers)
- **QUASI identifiers**: Should be masked (dates, locations, quasi-identifiers)
- **NO_MASK**: Should NOT be masked (publicly known information)

## Summary Scores

| Metric | Value |
|--------|-------|
| **R_direct** (recall of must-mask) | 0.4849 |
| **R_quasi** (recall of should-mask) | 0.0457 |
| **F1_direct** | 0.0000 |
| **F1_quasi** | 0.0000 |
| **Weighted F1** (DIRECT 2×, QUASI 1×) | 0.0000 |
| **Precision** (of masking decisions) | 0.0000 |

## Detection Quality (masking-agnostic)

| Metric | Value |
|--------|-------|
| **Detection Precision** | 0.0000 |
| **Detection Recall** | 0.0000 |
| **Detection F1** | 0.0000 |

## Re-identification Risk Assessment

❌ **HIGH RISK** — R_direct < 0.85: Significant risk of re-identification via direct identifiers.

❌ **HIGH RISK** — R_quasi < 0.65: Quasi-identifiers can combine to enable re-identification.

## Per-Entity Breakdown

| Entity Type | R_direct | R_quasi | F1 | Direct | Quasi | Total |
|-------------|----------|---------|-----|--------|-------|-------|
| CODE | 0.0000 | 0.0000 | 0.0000 | 135 | 187 | 328 |
| DATE_TIME | 1.0000 | 0.0000 | 0.0000 | 0 | 2488 | 2615 |
| LOCATION | 1.0000 | 0.0000 | 0.0000 | 0 | 533 | 979 |
| MISC | 1.0000 | 0.0000 | 0.0000 | 0 | 124 | 227 |
| ORGANIZATION | 0.0000 | 0.0000 | 0.0000 | 4 | 557 | 1937 |
| PERSON | 0.7832 | 0.2992 | 0.1881 | 226 | 732 | 1063 |
| QUANTITY | 1.0000 | 0.0000 | 0.0000 | 0 | 175 | 222 |

## Annotation Counts

| Category | Count |
|----------|-------|
| Gold DIRECT (must mask) | 365 |
| Gold QUASI (should mask) | 4796 |
| Gold NO_MASK (keep) | 2210 |
| Total predicted | 3254 |

## Methodology Notes

- **IoU threshold:** 0.5 for span matching
- **R_direct:** Recall of DIRECT identifiers that were correctly detected
- **R_quasi:** Recall of QUASI identifiers that were correctly detected
- **Precision:** Fraction of detected spans that correspond to spans needing masking
- **Weighted F1:** (2×F1_direct + 1×F1_quasi) / 3 — reflects higher cost of leaking DIRECT identifiers
- Entity types mapped from TAB's native types (PERSON, ORG, LOC, DATETIME, CODE, DEM)
