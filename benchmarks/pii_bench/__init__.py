"""
Phase 2: PII-Bench (Fudan) Academic Benchmark Integration.

PII-Bench is the first comprehensive evaluation framework for assessing
privacy protection systems, comprising 2,842 test samples across 7 PII
types with 55 fine-grained subcategories.

Paper: https://arxiv.org/abs/2502.18545
Metrics: Strict-F1, Entity-F1, RougeL-F

Sub-modules:
    downloader  — Dataset acquisition from PII-Bench GitHub release
    evaluator   — Evaluation adapter connecting Aelvyril to PII-Bench
    metrics     — Strict-F1, Entity-F1, RougeL-F implementations
"""
