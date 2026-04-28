"""
Nemotron-PII evaluation adapter — connects Aelvyril detection to benchmark metrics.

Orchestrates the full evaluation pipeline:
    1. Load Nemotron-PII dataset (download if needed)
    2. Send each sample through Aelvyril's detection endpoint
    3. Compute Strict-F1, Entity-F1, RougeL-F, and F₂
    4. Generate per-domain and per-entity breakdowns

Usage:
    python -m benchmarks.pii_bench.evaluator
    python -m benchmarks.pii_bench.evaluator --domains Healthcare Banking
    python -m benchmarks.pii_bench.evaluator --max-samples 5000
    python -m benchmarks.pii_bench.evaluator --service-url http://localhost:4242/v1/chat/completions
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from typing import Dict, List, Optional

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from benchmarks.common.metrics import CORE_SUPPORTED_TYPES
from benchmarks.common.reporting import generate_run_manifest
from benchmarks.common.utils import set_seeds
from benchmarks.presidio_research.aelvyril_evaluator import (
    AelvyrilEvaluator,
)
from benchmarks.pii_bench.downloader import (
    download_nemotron_pii,
    load_nemotron_pii,
    normalize_sample,
    NEMOTRON_ENTITY_MAP,
)
from benchmarks.pii_bench.metrics import (
    PiiBenchMetrics,
    Span,
    evaluate_pii_bench,
    strict_f1,
    entity_f1,
    rouge_l_f,
    fbeta_score,
)


def run_nemotron_evaluation(
    service_url: str = "http://localhost:4242/v1/chat/completions",
    tolerance: int = 0,
    seed: int = 42,
    output_dir: str = "benchmarks/pii_bench/results",
    skip_download: bool = False,
    max_samples: Optional[int] = None,
    domains: Optional[List[str]] = None,
    document_formats: Optional[List[str]] = None,
) -> PiiBenchMetrics:
    """Run the full Nemotron-PII evaluation against Aelvyril.

    Args:
        service_url: Aelvyril gateway endpoint URL.
        tolerance: Character tolerance for Strict-F1 (0 = exact).
        seed: Random seed for reproducibility.
        output_dir: Directory for results output.
        skip_download: Skip download if data already exists.
        max_samples: Limit samples (None = all 50,000).
        domains: Filter by industry domain.
        document_formats: Filter by document format.

    Returns:
        PiiBenchMetrics with computed scores.
    """
    set_seeds(seed)

    # ── Step 1: Load dataset ────────────────────────────────────────────────
    if not skip_download:
        data_dir = download_nemotron_pii()
    else:
        data_dir = "benchmarks/data/nemotron-pii"

    raw_samples = load_nemotron_pii(
        data_dir,
        max_samples=max_samples,
        domains=domains,
        document_formats=document_formats,
    )
    print(f"\n[INFO] Loaded {len(raw_samples)} Nemotron-PII samples")

    # ── Step 2: Initialize evaluator ────────────────────────────────────────
    evaluator = AelvyrilEvaluator(service_url=service_url, gateway_key="aelvyril-benchmark-key")

    # ── Step 3: Run detection on each sample ────────────────────────────────
    predicted_samples: List[List[Span]] = []
    gold_samples: List[List[Span]] = []
    text_lengths: List[int] = []
    domain_results: Dict[str, Dict] = {}
    format_results: Dict[str, Dict] = {}

    print(f"\n{'='*60}")
    print("Running Nemotron-PII Evaluation (Strict-F1 / Entity-F1 / RougeL-F)")
    print(f"{'='*60}")

    for i, raw in enumerate(raw_samples):
        sample = normalize_sample(raw)
        text = sample["text"]

        # Get Aelvyril predictions
        detected = evaluator.predict(text)

        # Convert to Span objects
        # Predictions come from the gateway as raw Presidio types — no mapping needed.
        # Gold spans are already mapped to Presidio types via NEMOTRON_ENTITY_MAP.
        # Both sides use the same canonical namespace for direct comparison.
        pred_spans = [
            Span(
                entity_type=d.entity_type,
                start=d.start,
                end=d.end,
                text=d.text,
                score=d.score,
            )
            for d in detected
        ]

        gold_spans = [
            Span(
                entity_type=s["entity_type"],
                start=s["start"],
                end=s["end"],
                text=s.get("text", ""),
            )
            for s in sample["spans"]
        ]

        predicted_samples.append(pred_spans)
        gold_samples.append(gold_spans)
        text_lengths.append(len(text))

        if (i + 1) % 1000 == 0:
            print(f"  Processed {i + 1}/{len(raw_samples)} samples...")

    print(f"  Processed {len(raw_samples)}/{len(raw_samples)} samples.")

    # ── Step 4: Health check ────────────────────────────────────────────────
    if not evaluator.is_healthy():
        print(
            f"[ERROR] Evaluator failure rate: {evaluator.failure_rate:.2%}. "
            "Results may be unreliable!"
        )

    # ── Step 5: Compute aggregate metrics ───────────────────────────────────
    metrics = evaluate_pii_bench(
        predicted_samples, gold_samples, text_lengths, tolerance=tolerance
    )

    # ── Step 6: Per-domain analysis ─────────────────────────────────────────
    sample_domains = [normalize_sample(s)["domain"] for s in raw_samples]
    unique_domains = set(sample_domains)

    for domain_name in sorted(unique_domains):
        indices = [i for i, d in enumerate(sample_domains) if d == domain_name]
        if len(indices) < 10:  # Skip tiny domains
            continue

        d_preds = [predicted_samples[i] for i in indices]
        d_golds = [gold_samples[i] for i in indices]
        d_lens = [text_lengths[i] for i in indices]

        d_metrics = evaluate_pii_bench(d_preds, d_golds, d_lens, tolerance=tolerance)
        domain_results[domain_name] = {
            **d_metrics.to_dict(),
            "num_samples": len(indices),
        }

    # ── Step 7: Per-format analysis ─────────────────────────────────────────
    sample_formats = [normalize_sample(s)["document_format"] for s in raw_samples]
    for fmt in sorted(set(sample_formats)):
        indices = [i for i, f in enumerate(sample_formats) if f == fmt]
        if not indices:
            continue

        f_preds = [predicted_samples[i] for i in indices]
        f_golds = [gold_samples[i] for i in indices]
        f_lens = [text_lengths[i] for i in indices]

        f_metrics = evaluate_pii_bench(f_preds, f_golds, f_lens, tolerance=tolerance)
        format_results[fmt] = {
            **f_metrics.to_dict(),
            "num_samples": len(indices),
        }

    # ── Step 8: Save results ────────────────────────────────────────────────
    os.makedirs(output_dir, exist_ok=True)

    # Compute per-sample metrics for bootstrap CI
    print("[INFO] Computing per-sample metric arrays for bootstrap...")
    per_sample_strict_f1: List[float] = []
    per_sample_entity_f1: List[float] = []
    per_sample_rouge_l_f: List[float] = []
    per_sample_f2: List[float] = []

    for pred, gold, text_len in zip(predicted_samples, gold_samples, text_lengths):
        s_prec, s_rec, s_f1 = strict_f1(pred, gold, tolerance)
        per_sample_strict_f1.append(s_f1)
        e_prec, e_rec, e_f1 = entity_f1(pred, gold, text_len)
        per_sample_entity_f1.append(e_f1)
        r_prec, r_rec, r_f1 = rouge_l_f(pred, gold)
        per_sample_rouge_l_f.append(r_f1)
        per_sample_f2.append(fbeta_score(s_prec, s_rec, beta=2.0))

    print(f"[OK] Computed per-sample arrays for {len(per_sample_strict_f1)} samples")

    result = {
        "aelvyril_version": "dev",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "data_source": "NVIDIA Nemotron-PII (CC BY 4.0)",
        "data_source_url": "https://huggingface.co/datasets/nvidia/Nemotron-PII",
        "benchmarks": {
            "pii_bench": metrics.to_dict(),
        },
        "domain_results": domain_results,
        "format_results": format_results,
        "per_sample": {
            "strict_f1": per_sample_strict_f1,
            "entity_f1": per_sample_entity_f1,
            "rouge_l_f": per_sample_rouge_l_f,
            "f2_score": per_sample_f2,
        },
        "config": {
            "tolerance": tolerance,
            "seed": seed,
            "num_samples": len(raw_samples),
            "max_samples": max_samples,
            "domains": domains,
            "document_formats": document_formats,
        },
        # Core aggregate: computed over only the 24 types Aelvyril can detect.
        # Excludes NRP (demographic attributes, not PII) and ID (no recognizer).
        # See benchmarks/common/metrics.py:CORE_SUPPORTED_TYPES.
        "core_aggregate": _compute_core_aggregate(metrics.per_entity),
    }

    # Save JSON using the standardized schema
    # Note: pii_bench uses plain dicts for per_entity (not EntityMetrics),
    # so we save via the full result dict directly instead of save_results_json.
    json_path = os.path.join(output_dir, f"bench_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.json")
    with open(json_path, "w") as f:
        json.dump(result, f, indent=2)
    latest_path = os.path.join(output_dir, "latest.json")
    with open(latest_path, "w") as f:
        json.dump(result, f, indent=2)
    print(f"[OK] JSON results saved -> {json_path}")

    # Save the full result
    full_path = os.path.join(output_dir, "pii_bench_results.json")
    with open(full_path, "w") as f:
        json.dump(result, f, indent=2)

    # Save latest
    latest_path = os.path.join(output_dir, "latest.json")
    with open(latest_path, "w") as f:
        json.dump(result, f, indent=2)

    generate_run_manifest(output_dir, seed=seed)

    # ── Step 9: Print summary ───────────────────────────────────────────────
    _print_summary(metrics, domain_results, format_results, tolerance)

    return metrics


def _print_summary(
    metrics: PiiBenchMetrics,
    domain_results: Dict[str, Dict],
    format_results: Dict[str, Dict],
    tolerance: int,
) -> None:
    """Print evaluation summary to stdout."""
    print(f"\n{'='*60}")
    print("Nemotron-PII Evaluation Results")
    print(f"{'='*60}")
    print(f"Dataset:      NVIDIA Nemotron-PII (CC BY 4.0)")
    print(f"Tolerance:    ±{tolerance} characters")
    print(f"Samples:      {metrics.num_samples:,}")
    print()

    print("┌─────────────────────────────────────────────────────────┐")
    print("│                  Aggregate Metrics                      │")
    print("├─────────────────────────────────────────────────────────┤")
    print(f"│  Strict-F1:     {metrics.strict_f1:.4f}                            │")
    print(f"│  Entity-F1:     {metrics.entity_f1:.4f}                            │")
    print(f"│  RougeL-F:      {metrics.rouge_l_f:.4f}                            │")
    print(f"│  F₂ (β=2):      {metrics.f2_score:.4f}                            │")
    print(f"│  Precision:     {metrics.strict_precision:.4f}                            │")
    print(f"│  Recall:        {metrics.strict_recall:.4f}                            │")
    print("└─────────────────────────────────────────────────────────┘")

    # Per-format results
    if format_results:
        print()
        print("Per-Format Results:")
        print(f"{'Format':<15} {'Strict-F1':>12} {'Entity-F1':>12} {'RougeL-F':>12} {'Samples':>10}")
        print("-" * 65)
        for fmt, data in sorted(format_results.items()):
            print(
                f"{fmt:<15} {data.get('strict_f1', 0):>12.4f} "
                f"{data.get('entity_f1', 0):>12.4f} "
                f"{data.get('rouge_l_f', 0):>12.4f} "
                f"{data.get('num_samples', 0):>10}"
            )

    # Top/bottom domains
    if domain_results:
        sorted_domains = sorted(
            domain_results.items(),
            key=lambda x: x[1].get("strict_f1", 0),
            reverse=True,
        )
        print()
        print("Per-Domain Results (top 10):")
        print(f"{'Domain':<30} {'Strict-F1':>12} {'Entity-F1':>12} {'Samples':>10}")
        print("-" * 68)
        for domain, data in sorted_domains[:10]:
            print(
                f"{domain:<30} {data.get('strict_f1', 0):>12.4f} "
                f"{data.get('entity_f1', 0):>12.4f} "
                f"{data.get('num_samples', 0):>10}"
            )

    # Per-entity results (top 15)
    if metrics.per_entity:
        sorted_entities = sorted(
            metrics.per_entity.items(),
            key=lambda x: x[1].get("strict_f1", 0),
            reverse=True,
        )
        print()
        print("Per-Entity Breakdown (top 15 by Strict-F1):")
        print(
            f"{'Entity':<20} {'Strict-F1':>12} {'Entity-F1':>12} "
            f"{'RougeL-F':>12} {'F₂':>8} {'Gold':>6} {'Pred':>6}"
        )
        print("-" * 80)
        for entity_type, data in sorted_entities[:15]:
            print(
                f"{entity_type:<20} {data.get('strict_f1', 0):>12.4f} "
                f"{data.get('entity_f1', 0):>12.4f} "
                f"{data.get('rouge_l_f', 0):>12.4f} "
                f"{data.get('f2', 0):>8.4f} "
                f"{data.get('gold_count', 0):>6} "
                f"{data.get('pred_count', 0):>6}"
            )


def generate_benchmark_results_md(
    metrics: PiiBenchMetrics,
    domain_results: Dict[str, Dict],
    format_results: Dict[str, Dict],
    output_dir: str,
) -> str:
    """Generate BENCHMARK_RESULTS.md report.

    Returns:
        Path to the generated report.
    """
    lines: List[str] = []
    lines.append("# Nemotron-PII Evaluation Results — Aelvyril PII Detection")
    lines.append("")
    lines.append(f"**Generated:** {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    lines.append(f"**Benchmark:** NVIDIA Nemotron-PII (CC BY 4.0)")
    lines.append(f"**Source:** https://huggingface.co/datasets/nvidia/Nemotron-PII")
    lines.append(f"**Primary Metric:** Strict-F1 (exact span match)")
    lines.append(f"**Samples:** {metrics.num_samples:,}")
    lines.append("")

    # Summary table
    lines.append("## Aggregate Scores")
    lines.append("")
    lines.append("| Metric | Score |")
    lines.append("|--------|-------|")
    lines.append(f"| **Strict-F1** | {metrics.strict_f1:.4f} |")
    lines.append(f"| **Entity-F1** | {metrics.entity_f1:.4f} |")
    lines.append(f"| **RougeL-F** | {metrics.rouge_l_f:.4f} |")
    lines.append(f"| **F₂ (β=2)** | {metrics.f2_score:.4f} |")
    lines.append(f"| **Precision** | {metrics.strict_precision:.4f} |")
    lines.append(f"| **Recall** | {metrics.strict_recall:.4f} |")
    lines.append("")

    # Per-format results
    if format_results:
        lines.append("## Per-Document Format")
        lines.append("")
        lines.append("| Format | Strict-F1 | Entity-F1 | RougeL-F | F₂ | Samples |")
        lines.append("|--------|-----------|-----------|----------|-----|---------|")
        for fmt, data in sorted(format_results.items()):
            lines.append(
                f"| {fmt} | {data.get('strict_f1', 0):.4f} "
                f"| {data.get('entity_f1', 0):.4f} "
                f"| {data.get('rouge_l_f', 0):.4f} "
                f"| {data.get('f2_score', 0):.4f} "
                f"| {data.get('num_samples', 0):,} |"
            )
        lines.append("")

    # Per-domain results
    if domain_results:
        sorted_domains = sorted(domain_results.items(), key=lambda x: x[1].get("strict_f1", 0), reverse=True)
        lines.append("## Per-Domain Breakdown")
        lines.append("")
        lines.append("| Domain | Strict-F1 | Entity-F1 | RougeL-F | F₂ | Samples |")
        lines.append("|--------|-----------|-----------|----------|-----|---------|")
        for domain, data in sorted_domains:
            lines.append(
                f"| {domain} | {data.get('strict_f1', 0):.4f} "
                f"| {data.get('entity_f1', 0):.4f} "
                f"| {data.get('rouge_l_f', 0):.4f} "
                f"| {data.get('f2_score', 0):.4f} "
                f"| {data.get('num_samples', 0):,} |"
            )
        lines.append("")

    # Per-entity results
    if metrics.per_entity:
        lines.append("## Per-Entity Type Breakdown")
        lines.append("")
        lines.append(
            "| Entity Type | Strict-F1 | Entity-F1 | RougeL-F | F₂ | Gold | Pred |"
        )
        lines.append(
            "|-------------|-----------|-----------|----------|-----|------|------|"
        )
        for entity_type, data in sorted(metrics.per_entity.items()):
            lines.append(
                f"| {entity_type} | {data.get('strict_f1', 0):.4f} "
                f"| {data.get('entity_f1', 0):.4f} "
                f"| {data.get('rouge_l_f', 0):.4f} "
                f"| {data.get('f2', 0):.4f} "
                f"| {data.get('gold_count', 0)} "
                f"| {data.get('pred_count', 0)} |"
            )
        lines.append("")

    # Methodology
    lines.append("## Methodology")
    lines.append("")
    lines.append("- **Dataset:** NVIDIA Nemotron-PII — 50k test samples, 55 entity types, CC BY 4.0")
    lines.append("- **Strict-F1:** Exact span match (start/end must match exactly)")
    lines.append("- **Entity-F1:** Token-level F1 with BIO tagging (partial overlap counted)")
    lines.append("- **RougeL-F:** LCS-based fuzzy matching (≥0.5 threshold)")
    lines.append("- **F₂ (β=2):** Recall-weighted F-score — missing PII is worse than over-redaction")
    lines.append("- Statistical significance validated via bootstrap resampling (10k iterations)")
    lines.append("")

    report_path = os.path.join(output_dir, "..", "..", "BENCHMARK_RESULTS.md")
    report_path = os.path.normpath(report_path)
    os.makedirs(os.path.dirname(report_path), exist_ok=True)
    with open(report_path, "w") as f:
        f.write("\n".join(lines))

    print(f"\nReport saved → {report_path}")
    return report_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Nemotron-PII Evaluation Runner")
    parser.add_argument(
        "--service-url",
        type=str,
        default="http://localhost:4242/v1/chat/completions",
        help="Aelvyril gateway endpoint URL",
    )
    parser.add_argument(
        "--tolerance",
        type=int,
        default=0,
        help="Character tolerance for Strict-F1 (0 = exact match)",
    )
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    parser.add_argument(
        "--output-dir",
        type=str,
        default="benchmarks/pii_bench/results",
        help="Output directory for results",
    )
    parser.add_argument(
        "--skip-download",
        action="store_true",
        help="Skip dataset download if data already exists",
    )
    parser.add_argument(
        "--max-samples",
        type=int,
        default=None,
        help="Limit number of samples (default: all 50,000)",
    )
    parser.add_argument(
        "--domains",
        nargs="+",
        default=None,
        help="Filter by industry domain (e.g., Healthcare Banking)",
    )
    parser.add_argument(
        "--document-formats",
        nargs="+",
        default=None,
        choices=["structured", "unstructured"],
        help="Filter by document format",
    )
    args = parser.parse_args()

    metrics = run_nemotron_evaluation(
        service_url=args.service_url,
        tolerance=args.tolerance,
        seed=args.seed,
        output_dir=args.output_dir,
        skip_download=args.skip_download,
        max_samples=args.max_samples,
        domains=args.domains,
        document_formats=args.document_formats,
    )

    # Generate the BENCHMARK_RESULTS.md deliverable
    generate_benchmark_results_md(metrics, {}, {}, args.output_dir)


def _compute_core_aggregate(per_entity: dict) -> dict:
    """Compute aggregate metrics over only core supported types.

    Filters per-entity metrics to the types Aelvyril can detect
    (CORE_SUPPORTED_TYPES), excluding NRP and ID which are not PII
    or have no recognizer. Returns a dict suitable for JSON output.
    """
    core_f2 = 0.0
    core_precision = 0.0
    core_recall = 0.0
    total_gold = 0
    total_pred = 0
    core_count = 0

    for etype, data in per_entity.items():
        if etype not in CORE_SUPPORTED_TYPES:
            continue
        core_count += 1
        total_gold += data.get("gold_count", 0)
        total_pred += data.get("pred_count", 0)
        core_f2 += data.get("f2", 0)
        core_precision += data.get("strict_precision", 0)
        core_recall += data.get("strict_recall", 0)

    n = max(core_count, 1)
    return {
        "num_core_types": core_count,
        "total_gold_spans": total_gold,
        "total_pred_spans": total_pred,
        "avg_f2": round(core_f2 / n, 4),
        "avg_precision": round(core_precision / n, 4),
        "avg_recall": round(core_recall / n, 4),
        "included_types": sorted(
            et for et in per_entity if et in CORE_SUPPORTED_TYPES
        ),
        "excluded_types": sorted(
            et for et in per_entity if et not in CORE_SUPPORTED_TYPES
        ),
    }


if __name__ == "__main__":
    main()
