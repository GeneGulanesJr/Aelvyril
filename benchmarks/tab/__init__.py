"""
Phase 2: TAB (Text Anonymization Benchmark) Integration.

TAB measures re-identification risk, not just entity detection.
It evaluates whether an anonymization system correctly decides WHICH
personally identifiable spans to mask.

Key distinction: TAB goes beyond detection — it assesses whether the
masking decisions protect against re-identification.

Dataset: 1,268 ECHR court cases
    - Entity types: PERSON, ORG, LOC, DATETIME, CODE, DEM (demographic)
    - Masking decisions: DIRECT (must mask), QUASI (should mask), NO_MASK

Paper: https://arxiv.org/abs/2202.00443
GitHub: https://github.com/NorskRegnesentral/text-anonymization-benchmark

Metrics:
    - R_direct: Recall of DIRECT identifiers that were correctly masked
    - R_quasi: Recall of QUASI identifiers that were correctly masked
    - Precision: Fraction of masked spans that actually needed masking
    - F_direct: F1 for DIRECT identifier masking
    - F_quasi: F1 for QUASI identifier masking
"""
