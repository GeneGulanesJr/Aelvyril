"""
Phase 2: PII Detection Benchmark using NVIDIA Nemotron-PII dataset.

Nemotron-PII is a synthetic, persona-grounded dataset for training and
evaluating detection of PII/PHI in text. It contains 100,000 English
records across 50+ industries with span-level annotations for 55 PII/PHI
categories.

    - 50,000 test samples with character-offset span annotations
    - Structured (forms, invoices) and unstructured (emails, free text)
    - U.S. locale coverage
    - 55 entity types including names, SSNs, medical records, financial data

Source: https://huggingface.co/datasets/nvidia/Nemotron-PII
License: CC BY 4.0
Metrics: Strict-F1, Entity-F1, RougeL-F, F₂

Sub-modules:
    downloader  — Dataset acquisition from HuggingFace
    evaluator   — Evaluation adapter connecting Aelvyril to Nemotron-PII
    metrics     — Strict-F1, Entity-F1, RougeL-F implementations
"""
