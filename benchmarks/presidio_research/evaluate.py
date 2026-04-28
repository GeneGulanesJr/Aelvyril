"""
Phase 1 evaluation script — Aelvyril vs Vanilla Presidio baseline.

Runs two evaluations:
    1. Vanilla Presidio baseline (direct Presidio API call)
    2. Aelvyril pipeline (Presidio + custom recognizers + overlap resolution)

Produces per-entity F₂ scores and a comparison report.

Metric semantics (v4 — fixed):
    - "raw"   = entity type as output by the system, no mapping.
                Enables cross-system comparison at the exact types they emit.
    - "canonical" = mapped to the benchmark's shared canonical namespace
                    (UPPER_SNAKE_CASE Presidio types). Enables per-type
                    comparison across systems using a common reference schema.

Both gold and predictions are always in the same namespace before scoring —
never compare uppercase vs Display names.

Usage:
    python -m benchmarks.presidio_research.evaluate --num-samples 1000
    python -m benchmarks.presidio_research.evaluate --data benchmarks/data/synthetic_llm_prompts.json
    python -m benchmarks.presidio_research.evaluate --aelvyril-only
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

# Add parent to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from benchmarks.common.metrics import (
    EntityMetrics,
    SpanMatch,
    evaluate_entity_types,
    compute_aggregate,
)
from benchmarks.common.reporting import (
    format_results_as_markdown,
    generate_run_manifest,
    save_results_json,
)
from benchmarks.common.utils import set_seeds

# Import Aelvyril evaluator
from benchmarks.presidio_research.aelvyril_evaluator import (
    AelvyrilEvaluator,
)


# ── Gold canonicalization ─────────────────────────────────────────────────────
#
# Maps dataset-native entity types to the benchmark canonical namespace.
# This is the ONLY place gold types are mapped — predictions use raw types.
#
# The canonical namespace is UPPER_SNAKE_CASE Presidio types (EMAIL_ADDRESS,
# US_SSN, CITY, US_STATE, STREET_ADDRESS, etc.) — matching what Aelvyril's
# PiiType::Display emits. Both sides of the comparison use the same string
# so scoring is a simple equality check.

GOLD_TO_CANONICAL: Dict[str, str] = {
    # Core PII
    "EMAIL_ADDRESS": "EMAIL_ADDRESS",
    "PHONE_NUMBER": "PHONE_NUMBER",
    "CREDIT_CARD": "CREDIT_CARD",
    "US_SSN": "US_SSN",
    "SSN": "US_SSN",
    "IBAN_CODE": "IBAN_CODE",
    "IBAN": "IBAN_CODE",
    "IP_ADDRESS": "IP_ADDRESS",
    "API_KEY": "API_KEY",
    "URL": "URL",
    "DATE_TIME": "DATE_TIME",
    "US_ZIP_CODE": "US_ZIP_CODE",
    "ZIP_CODE": "US_ZIP_CODE",
    # NER (fine-grained, no collapsing)
    "PERSON": "PERSON",
    "PER": "PERSON",
    "LOCATION": "LOCATION",
    "LOC": "LOCATION",
    "CITY": "CITY",
    "US_STATE": "US_STATE",
    "STREET_ADDRESS": "STREET_ADDRESS",
    "COUNTRY": "COUNTRY",
    "ORGANIZATION": "ORGANIZATION",
    "ORG": "ORGANIZATION",
    # Fine-grained identifiers
    "SWIFT_CODE": "SWIFT_CODE",
    "US_BANK_NUMBER": "US_BANK_NUMBER",
    "US_PASSPORT": "US_PASSPORT",
    "US_DRIVER_LICENSE": "US_DRIVER_LICENSE",
    # Other
    "AGE": "AGE",
    "TITLE": "TITLE",
    "NATIONALITY": "NATIONALITY",
    "MEDICAL_RECORD": "MEDICAL_RECORD",
    # Passthrough for unknown types (keeps original uppercase)
}


def canonicalize(entity_type: str) -> str:
    """Map a gold entity type to the benchmark canonical namespace.

    Unknown types pass through unchanged (uppercase is preserved).
    This ensures transparent "unrecognized type" reporting in scores.
    """
    result = GOLD_TO_CANONICAL.get(entity_type, entity_type)
    if not result:
        raise ValueError(
            f"GOLD_TO_CANONICAL mapped '{entity_type}' to empty string — "
            f"this is a sentinel poison bug. Fix the mapping dict."
        )
    return result


def load_dataset(path: str) -> List[dict]:
    """Load test dataset from JSON."""
    with open(path) as f:
        return json.load(f)


def dicts_to_spanmatches(raw_spans: List[dict]) -> List[SpanMatch]:
    """Convert raw span dicts to SpanMatch objects preserving original entity_type."""
    return [
        SpanMatch(
            entity_type=s.get("entity_type", "UNKNOWN"),
            start=s.get("start", 0),
            end=s.get("end", 0),
            text=s.get("text", ""),
            score=s.get("score", 1.0),
        )
        for s in raw_spans
    ]


def run_vanilla_presidio(
    samples: List[dict],
    service_url: str = "http://localhost:3000/analyze",
) -> Tuple[
    Dict[str, EntityMetrics],      # canonical (gold mapped to canonical namespace)
    Dict[str, EntityMetrics],      # raw (gold in dataset-native types)
    Dict[str, List[float]],        # per-sample canonical F₂
    Dict[str, List[float]],        # per-sample raw F₂
]:
    """Run vanilla Presidio baseline evaluation with canonical and raw metrics.

    canonical: gold → canonical namespace (via GOLD_TO_CANONICAL)
               pred → raw Presidio types (uppercase, as returned by /analyze)
               Compares canonical(gold) == pred (uppercase)

    raw:      gold → dataset-native types (as stored in samples["spans"])
               pred → raw Presidio types (uppercase)
               Compares raw_gold == pred (both uppercase)

    Returns 4-tuple: (canonical_metrics, raw_metrics, per_sample_canonical, per_sample_raw)
    """
    import requests

    all_pred_canon: List[SpanMatch] = []
    all_gold_canon: List[SpanMatch] = []
    all_pred_raw: List[SpanMatch] = []
    all_gold_raw: List[SpanMatch] = []

    per_sample_c_f2: List[float] = []
    per_sample_c_rec: List[float] = []
    per_sample_r_f2: List[float] = []
    per_sample_r_rec: List[float] = []

    print(f"\n{'='*60}")
    print("Running Vanilla Presidio Baseline...")
    print(f"{'='*60}")

    for i, sample in enumerate(samples):
        text = sample["text"]
        gold_raw_dicts = sample.get("spans", [])

        # Raw gold: dataset-native types (no mapping)
        gold_raw = dicts_to_spanmatches(gold_raw_dicts)

        # Canonical gold: mapped to benchmark canonical namespace
        gold_canon = [
            SpanMatch(
                entity_type=canonicalize(s.get("entity_type", "UNKNOWN")),
                start=s.get("start", 0),
                end=s.get("end", 0),
                text=s.get("text", ""),
                score=s.get("score", 1.0),
            )
            for s in gold_raw_dicts
        ]

        try:
            resp = requests.post(
                service_url,
                json={"text": text, "language": "en"},
                timeout=10,
            )
            resp.raise_for_status()
            data = resp.json()
            results = data.get("result", data) if isinstance(data, dict) else data

            # Raw predictions: Presidio's native types (uppercase)
            pred_raw = [
                SpanMatch(
                    entity_type=r.get("entity_type", "UNKNOWN"),
                    start=r.get("start", 0),
                    end=r.get("end", 0),
                    score=r.get("score", 0.0),
                    text=r.get("text", ""),
                )
                for r in results
            ]
        except requests.RequestException as e:
            if i % 100 == 0:
                print(f"  [WARN] Sample {i} failed: {e}")
            pred_raw = []

        # Canonical predictions: same raw predictions (Presidio → canonical = identity)
        pred_canon = pred_raw  # Presidio types are already uppercase canonical namespace

        all_pred_canon.extend(pred_canon)
        all_gold_canon.extend(gold_canon)
        all_pred_raw.extend(pred_raw)
        all_gold_raw.extend(gold_raw)

        # Per-sample canonical evaluation
        sample_em_c = evaluate_entity_types(pred_canon, gold_canon)
        sample_agg_c = compute_aggregate(sample_em_c, average="micro")
        per_sample_c_f2.append(sample_agg_c.f2)
        per_sample_c_rec.append(sample_agg_c.recall)

        # Per-sample raw evaluation
        sample_em_r = evaluate_entity_types(pred_raw, gold_raw)
        sample_agg_r = compute_aggregate(sample_em_r, average="micro")
        per_sample_r_f2.append(sample_agg_r.f2)
        per_sample_r_rec.append(sample_agg_r.recall)

        if (i + 1) % 200 == 0:
            print(f"  Processed {i + 1}/{len(samples)} samples...")

    canonical_metrics = evaluate_entity_types(all_pred_canon, all_gold_canon)
    raw_metrics = evaluate_entity_types(all_pred_raw, all_gold_raw)

    per_sample_canonical = {"f2": per_sample_c_f2, "recall": per_sample_c_rec}
    per_sample_raw = {"f2": per_sample_r_f2, "recall": per_sample_r_rec}

    return canonical_metrics, raw_metrics, per_sample_canonical, per_sample_raw


def run_aelvyril(
    samples: List[dict],
    service_url: str = "http://localhost:4242/v1/chat/completions",
    gateway_key: str | None = None,
) -> Tuple[
    Dict[str, EntityMetrics],      # canonical
    Dict[str, EntityMetrics],      # raw
    Dict[str, List[float]],        # per-sample canonical F₂
    Dict[str, List[float]],        # per-sample raw F₂
]:
    """Run Aelvyril evaluation via the full pipeline, returning canonical and raw metrics.

    canonical: gold → canonical namespace (via GOLD_TO_CANONICAL)
               pred → canonical namespace (Aelvyril PiiType::Display = uppercase)
               Compares canonical(gold) == pred (both uppercase)

    raw:      gold → dataset-native types (no mapping)
               pred → Aelvyril's internal PiiType enum variant name
                      (PascalCase, e.g., Email, PhoneNumber, City, UsState)
               Used for debugging when Aelvyril's output doesn't match gold.

    Returns 4-tuple: (canonical_metrics, raw_metrics, per_sample_canonical, per_sample_raw)
    """
    evaluator = AelvyrilEvaluator(service_url=service_url, gateway_key=gateway_key)

    all_pred_canon: List[SpanMatch] = []
    all_gold_canon: List[SpanMatch] = []
    all_pred_raw: List[SpanMatch] = []
    all_gold_raw: List[SpanMatch] = []

    per_sample_c_f2: List[float] = []
    per_sample_c_rec: List[float] = []
    per_sample_r_f2: List[float] = []
    per_sample_r_rec: List[float] = []

    print(f"\n{'='*60}")
    print("Running Aelvyril Pipeline Evaluation...")
    print(f"{'='*60}")

    for i, sample in enumerate(samples):
        text = sample["text"]
        gold_raw_dicts = sample.get("spans", [])

        # Raw gold: dataset-native types (no mapping)
        gold_raw = dicts_to_spanmatches(gold_raw_dicts)

        # Canonical gold: mapped to benchmark canonical namespace
        gold_canon = [
            SpanMatch(
                entity_type=canonicalize(s.get("entity_type", "UNKNOWN")),
                start=s.get("start", 0),
                end=s.get("end", 0),
                text=s.get("text", ""),
                score=s.get("score", 1.0),
            )
            for s in gold_raw_dicts
        ]

        # Canonical predictions: Aelvyril's PiiType::Display (uppercase Presidio names)
        # e.g., Email → EMAIL_ADDRESS, City → CITY, UsState → US_STATE
        detected = evaluator.predict(text)
        pred_canon = [
            SpanMatch(
                entity_type=d.entity_type,  # already uppercase from Rust PiiType::Display
                start=d.start,
                end=d.end,
                score=d.score,
                text=d.text,
            )
            for d in detected
        ]

        # Raw predictions: Aelvyril's internal PiiType variant names (PascalCase)
        # e.g., Email, City, UsState, CreditCard, SwiftCode, UsPassport
        # This exposes the full set of types Aelvyril can emit, including those
        # that don't yet appear in the canonical mapping.
        raw_dicts = evaluator.predict_raw(text)
        pred_raw = [
            SpanMatch(
                entity_type=r.get("raw_entity_type", r.get("entity_type", "UNKNOWN")),
                start=r.get("start", 0),
                end=r.get("end", 0),
                score=r.get("confidence", r.get("score", 0.0)),
                text=r.get("text", ""),
            )
            for r in raw_dicts
        ]

        all_pred_canon.extend(pred_canon)
        all_gold_canon.extend(gold_canon)
        all_pred_raw.extend(pred_raw)
        all_gold_raw.extend(gold_raw)

        # Per-sample canonical evaluation
        sample_em_c = evaluate_entity_types(pred_canon, gold_canon)
        sample_agg_c = compute_aggregate(sample_em_c, average="micro")
        per_sample_c_f2.append(sample_agg_c.f2)
        per_sample_c_rec.append(sample_agg_c.recall)

        # Per-sample raw evaluation
        sample_em_r = evaluate_entity_types(pred_raw, gold_raw)
        sample_agg_r = compute_aggregate(sample_em_r, average="micro")
        per_sample_r_f2.append(sample_agg_r.f2)
        per_sample_r_rec.append(sample_agg_r.recall)

        if (i + 1) % 200 == 0:
            print(f"  Processed {i + 1}/{len(samples)} samples...")

    if not evaluator.is_healthy():
        print(
            f"[ERROR] Evaluator failure rate: {evaluator.failure_rate:.2%}. "
            "Results may be unreliable!"
        )

    canonical_metrics = evaluate_entity_types(all_pred_canon, all_gold_canon)
    raw_metrics = evaluate_entity_types(all_pred_raw, all_gold_raw)

    per_sample_canonical = {"f2": per_sample_c_f2, "recall": per_sample_c_rec}
    per_sample_raw = {"f2": per_sample_r_f2, "recall": per_sample_r_rec}

    return canonical_metrics, raw_metrics, per_sample_canonical, per_sample_raw


def main() -> None:
    parser = argparse.ArgumentParser(description="Phase 1 PII Benchmark Evaluation")
    parser.add_argument(
        "--data",
        type=str,
        default=None,
        help="Path to test dataset JSON (generates synthetic if not provided)",
    )
    parser.add_argument("--num-samples", type=int, default=1000, help="Number of synthetic samples")
    parser.add_argument("--seed", type=int, default=42, help="Random seed for reproducibility")
    parser.add_argument(
        "--service-url",
        type=str,
        default="http://localhost:3000/analyze",
        help="Presidio/Aelvyril service URL",
    )
    parser.add_argument(
        "--baseline-url",
        type=str,
        default=None,
        help="Separate service URL for vanilla Presidio baseline",
    )
    parser.add_argument(
        "--gateway-key",
        type=str,
        default="aelvyril-benchmark-key",
        help="Gateway auth token (matches headless binary)",
    )
    parser.add_argument(
        "--aelvyril-only",
        action="store_true",
        help="Skip vanilla Presidio baseline, run Aelvyril only",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="benchmarks/presidio_research/results",
        help="Directory for output files",
    )
    parser.add_argument(
        "--generate-only",
        action="store_true",
        help="Only generate synthetic data, don't run evaluation",
    )
    args = parser.parse_args()

    set_seeds(args.seed)

    # ── Generate or load dataset ──────────────────────────────────────────────
    if args.data:
        print(f"Loading dataset from {args.data}")
        samples = load_dataset(args.data)
    else:
        from benchmarks.data_generators.llm_prompt_templates import LLMPromptDataGenerator

        print(f"Generating {args.num_samples} synthetic samples (seed={args.seed})")
        gen = LLMPromptDataGenerator(seed=args.seed)
        dataset = gen.generate_dataset(args.num_samples)
        samples = [{"text": s.text, "spans": s.spans} for s in dataset]

        os.makedirs("benchmarks/data", exist_ok=True)
        data_path = "benchmarks/data/synthetic_llm_prompts.json"
        gen.save_dataset(dataset, data_path)
        print(f"Saved synthetic data → {data_path}")

    if args.generate_only:
        print("Data generation complete. Exiting.")
        return

    print(f"\nDataset: {len(samples)} samples")

    # ── Generate run manifest ───────────────────────────────────────────────
    generate_run_manifest(args.output_dir, seed=args.seed)

    # ── Derive endpoint URLs ───────────────────────────────────────────────
    base = args.service_url.rstrip("/")
    if base.endswith("/v1/chat/completions"):
        chat_endpoint = base
        analyze_endpoint = base.replace("/v1/chat/completions", "/analyze")
    elif base.endswith("/analyze"):
        analyze_endpoint = base
        chat_endpoint = base.replace("/analyze", "/v1/chat/completions")
    else:
        analyze_endpoint = f"{base}/analyze"
        chat_endpoint = f"{base}/v1/chat/completions"

    if args.baseline_url:
        analyze_endpoint = args.baseline_url.rstrip("/")

    # ── Run evaluations ─────────────────────────────────────────────────────
    baseline_metrics: Optional[Dict[str, EntityMetrics]] = None
    raw_baseline_metrics: Optional[Dict[str, EntityMetrics]] = None

    if not args.aelvyril_only:
        (
            baseline_metrics,
            raw_baseline_metrics,
            per_sample_baseline_canonical,
            per_sample_baseline_raw,
        ) = run_vanilla_presidio(samples, analyze_endpoint)
        baseline_agg = compute_aggregate(baseline_metrics, average="micro")
        raw_baseline_agg = compute_aggregate(raw_baseline_metrics, average="micro")
        print(f"\nVanilla Presidio Baseline:")
        print(f"  canonical  F₂ = {baseline_agg.f2:.4f}  Recall = {baseline_agg.recall:.4f}")
        print(f"  raw        F₂ = {raw_baseline_agg.f2:.4f}  Recall = {raw_baseline_agg.recall:.4f}")

    (
        aelvyril_metrics,
        raw_aelvyril_metrics,
        per_sample_aelvyril_canonical,
        per_sample_aelvyril_raw,
    ) = run_aelvyril(samples, chat_endpoint, gateway_key=args.gateway_key)
    aelvyril_agg = compute_aggregate(aelvyril_metrics, average="micro")
    raw_aelvyril_agg = compute_aggregate(raw_aelvyril_metrics, average="micro")
    print(f"\nAelvyril Pipeline:")
    print(f"  canonical  F₂ = {aelvyril_agg.f2:.4f}  Recall = {aelvyril_agg.recall:.4f}")
    print(f"  raw        F₂ = {raw_aelvyril_agg.f2:.4f}  Recall = {raw_aelvyril_agg.recall:.4f}")

    # ── Build baseline comparison dict ──────────────────────────────────────
    baseline_comparison: Optional[Dict[str, Dict]] = None
    if baseline_metrics:
        baseline_comparison = {
            k: {"f2": v.f2, "recall": v.recall, "precision": v.precision}
            for k, v in baseline_metrics.items()
        }

    # ── Save results ─────────────────────────────────────────────────────────
    json_path = save_results_json(
        aelvyril_metrics,
        aelvyril_agg,
        args.output_dir,
        extra_meta={
            "benchmark": "presidio-research",
            "num_samples": len(samples),
            "iou_threshold": 0.5,
            "metric_semantics": {
                "canonical": "gold→canonical via GOLD_TO_CANONICAL, pred→raw Presidio types (uppercase)",
                "raw": "gold→dataset-native (no mapping), pred→raw Presidio types (uppercase)",
            },
            "baseline": baseline_comparison,
            # Raw entity-type metrics (unmapped)
            "raw_entity_metrics": {k: v.to_dict() for k, v in raw_aelvyril_metrics.items()},
            "raw_aggregate": raw_aelvyril_agg.to_dict(),
            "raw_baseline_entity_metrics": {
                k: v.to_dict() for k, v in raw_baseline_metrics.items()
            }
            if raw_baseline_metrics else None,
            "raw_baseline_aggregate": raw_baseline_agg.to_dict()
            if raw_baseline_metrics else None,
            # Per-sample arrays
            "per_sample": {
                "canonical": per_sample_aelvyril_canonical,
                "raw": per_sample_aelvyril_raw,
            },
            "baseline_per_sample": {
                "canonical": per_sample_baseline_canonical
                if not args.aelvyril_only else None,
                "raw": per_sample_baseline_raw
                if not args.aelvyril_only else None,
            },
        },
    )
    print(f"\nResults saved → {json_path}")

    # ── Generate Markdown report ────────────────────────────────────────────
    md = format_results_as_markdown(
        aelvyril_metrics,
        aelvyril_agg,
        title="Phase 1: Aelvyril PII Detection Benchmark Results",
        baseline=baseline_comparison,
    )

    md += "\n## Per-Entity Detail\n\n"
    for entity_type in sorted(aelvyril_metrics.keys()):
        m = aelvyril_metrics[entity_type]
        md += f"### {entity_type}\n"
        md += f"- TP: {m.true_positives}  FP: {m.false_positives}  FN: {m.false_negatives}\n"
        md += f"- Recall: {m.recall:.4f}  Precision: {m.precision:.4f}  F₂: {m.f2:.4f}\n\n"

    if baseline_metrics:
        md += "\n## Baseline Comparison\n\n"
        md += "| Entity Type | Aelvyril F₂ | Baseline F₂ | Δ F₂ |\n"
        md += "|-------------|-------------|-------------|------|\n"
        for entity_type in sorted(
            set(list(aelvyril_metrics.keys()) + list(baseline_metrics.keys()))
        ):
            a_f2 = aelvyril_metrics.get(entity_type, EntityMetrics(entity_type)).f2
            b_f2 = baseline_metrics.get(entity_type, EntityMetrics(entity_type)).f2
            delta = a_f2 - b_f2
            md += f"| {entity_type} | {a_f2:.4f} | {b_f2:.4f} | {delta:+.4f} |\n"
        md += "\n"

    report_path = os.path.join(args.output_dir, "F2_AELVYRIL.md")
    os.makedirs(args.output_dir, exist_ok=True)
    with open(report_path, "w") as f:
        f.write(md)
    print(f"Report saved → {report_path}")


if __name__ == "__main__":
    main()