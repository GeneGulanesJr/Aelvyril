"""
Phase 1 evaluation script — Aelvyril vs Vanilla Presidio baseline.

Runs two evaluations:
    1. Vanilla Presidio baseline (direct Presidio API call)
    2. Aelvyril pipeline (Presidio + custom recognizers + overlap resolution)

Produces per-entity F₂ scores and a comparison report.

Usage:
    # Generate synthetic data and run full evaluation
    python -m benchmarks.presidio_research.evaluate --num-samples 1000

    # Run with existing dataset
    python -m benchmarks.presidio_research.evaluate --data benchmarks/data/synthetic_llm_prompts.json

    # Skip baseline (Aelvyril only)
    python -m benchmarks.presidio_research.evaluate --aelvyril-only
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any, Dict, List, Optional

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
    PRESIDIO_TO_AELVYRIL,
)


def load_dataset(path: str) -> List[dict]:
    """Load test dataset from JSON."""
    with open(path) as f:
        return json.load(f)


def to_spans(raw_spans: List[dict]) -> List[SpanMatch]:
    """Convert raw span dicts to SpanMatch objects."""
    return [
        SpanMatch(
            entity_type=PRESIDIO_TO_AELVYRIL.get(s["entity_type"], s["entity_type"]),
            start=s["start"],
            end=s["end"],
            text=s.get("text", ""),
        )
        for s in raw_spans
    ]


def run_vanilla_presidio(
    samples: List[dict],
    service_url: str = "http://localhost:3000/analyze",
) -> Dict[str, EntityMetrics]:
    """Run vanilla Presidio baseline evaluation.

    Calls the Presidio service directly, bypassing Aelvyril's custom recognizers.
    This measures raw Presidio accuracy for comparison.
    """
    import requests

    all_predicted: List[SpanMatch] = []
    all_gold: List[SpanMatch] = []

    print(f"\n{'='*60}")
    print("Running Vanilla Presidio Baseline...")
    print(f"{'='*60}")

    for i, sample in enumerate(samples):
        text = sample["text"]
        gold_spans = to_spans(sample.get("spans", []))

        try:
            resp = requests.post(
                service_url,
                json={"text": text, "language": "en"},
                timeout=10,
            )
            resp.raise_for_status()
            data = resp.json()
            results = data.get("result", data) if isinstance(data, dict) else data

            pred_spans = [
                SpanMatch(
                    entity_type=PRESIDIO_TO_AELVYRIL.get(
                        r.get("entity_type", "UNKNOWN"),
                        r.get("entity_type", "UNKNOWN"),
                    ),
                    start=r.get("start", 0),
                    end=r.get("end", 0),
                    score=r.get("score", 0.0),
                )
                for r in results
            ]
        except requests.RequestException as e:
            if i % 100 == 0:
                print(f"  [WARN] Sample {i} failed: {e}")
            pred_spans = []

        all_predicted.extend(pred_spans)
        all_gold.extend(gold_spans)

        if (i + 1) % 200 == 0:
            print(f"  Processed {i + 1}/{len(samples)} samples...")

    return evaluate_entity_types(all_predicted, all_gold)


def run_aelvyril(
    samples: List[dict],
    service_url: str = "http://localhost:3000/analyze",
) -> Dict[str, EntityMetrics]:
    """Run Aelvyril evaluation via the full pipeline."""
    evaluator = AelvyrilEvaluator(service_url=service_url)

    all_predicted: List[SpanMatch] = []
    all_gold: List[SpanMatch] = []

    print(f"\n{'='*60}")
    print("Running Aelvyril Pipeline Evaluation...")
    print(f"{'='*60}")

    for i, sample in enumerate(samples):
        text = sample["text"]
        gold_spans = to_spans(sample.get("spans", []))

        detected = evaluator.predict(text)
        pred_spans = [
            SpanMatch(
                entity_type=d.entity_type,
                start=d.start,
                end=d.end,
                score=d.score,
                text=d.text,
            )
            for d in detected
        ]

        all_predicted.extend(pred_spans)
        all_gold.extend(gold_spans)

        if (i + 1) % 200 == 0:
            print(f"  Processed {i + 1}/{len(samples)} samples...")

    # Health check after run
    if not evaluator.is_healthy():
        print(
            f"[ERROR] Evaluator failure rate: {evaluator.failure_rate:.2%}. "
            "Results may be unreliable!"
        )

    return evaluate_entity_types(all_predicted, all_gold)


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

    # ── Generate or load dataset ────────────────────────────────────────────
    if args.data:
        print(f"Loading dataset from {args.data}")
        samples = load_dataset(args.data)
    else:
        from benchmarks.data_generators.llm_prompt_templates import LLMPromptDataGenerator

        print(f"Generating {args.num_samples} synthetic samples (seed={args.seed})")
        gen = LLMPromptDataGenerator(seed=args.seed)
        dataset = gen.generate_dataset(args.num_samples)
        samples = [{"text": s.text, "spans": s.spans} for s in dataset]

        # Save generated data
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

    # ── Run evaluations ─────────────────────────────────────────────────────
    baseline_metrics: Optional[Dict[str, EntityMetrics]] = None
    if not args.aelvyril_only:
        baseline_metrics = run_vanilla_presidio(samples, args.service_url)
        baseline_agg = compute_aggregate(baseline_metrics)
        print(f"\nVanilla Presidio Baseline:")
        print(f"  F₂ = {baseline_agg.f2:.4f}  Recall = {baseline_agg.recall:.4f}  "
              f"Precision = {baseline_agg.precision:.4f}")

    aelvyril_metrics = run_aelvyril(samples, args.service_url)
    aelvyril_agg = compute_aggregate(aelvyril_metrics)
    print(f"\nAelvyril Pipeline:")
    print(f"  F₂ = {aelvyril_agg.f2:.4f}  Recall = {aelvyril_agg.recall:.4f}  "
          f"Precision = {aelvyril_agg.precision:.4f}")

    # ── Build baseline comparison dict ──────────────────────────────────────
    baseline_comparison: Optional[Dict[str, Dict]] = None
    if baseline_metrics:
        baseline_comparison = {
            k: {"f2": v.f2, "recall": v.recall, "precision": v.precision}
            for k, v in baseline_metrics.items()
        }

    # ── Save results ────────────────────────────────────────────────────────
    json_path = save_results_json(
        aelvyril_metrics,
        aelvyril_agg,
        args.output_dir,
        extra_meta={"baseline": baseline_comparison},
    )
    print(f"\nResults saved → {json_path}")

    # ── Generate Markdown report ────────────────────────────────────────────
    md = format_results_as_markdown(
        aelvyril_metrics,
        aelvyril_agg,
        title="Phase 1: Aelvyril PII Detection Benchmark Results",
        baseline=baseline_comparison,
    )

    # Append per-entity detail section
    md += "\n## Per-Entity Detail\n\n"
    for entity_type in sorted(aelvyril_metrics.keys()):
        m = aelvyril_metrics[entity_type]
        md += f"### {entity_type}\n"
        md += f"- TP: {m.true_positives}  FP: {m.false_positives}  FN: {m.false_negatives}\n"
        md += f"- Recall: {m.recall:.4f}  Precision: {m.precision:.4f}  "
        md += f"F₂: {m.f2:.4f}  F₁: {m.f1:.4f}\n\n"

    # If baseline exists, add comparison
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
