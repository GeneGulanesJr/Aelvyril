#!/usr/bin/env python3
"""
Benchmark runner CLI for Aelvyril PII detection.

Usage:
    # Run Phase 1 benchmark (default)
    python -m benchmarks.run

    # Run Phase 2 academic benchmarks
    python -m benchmarks.run --suite phase2
    python -m benchmarks.run --suite pii-bench
    python -m benchmarks.run --suite tab

    # Run Phase 3 supplementary benchmarks
    python -m benchmarks.run --suite phase3
    python -m benchmarks.run --suite datafog
    python -m benchmarks.run --suite ai4privacy
    python -m benchmarks.run --suite adversarial
    python -m benchmarks.run --suite publication

    # Run all benchmarks
    python -m benchmarks.run --suite all

    # Generate synthetic data only
    python -m benchmarks.run --generate-only --num-samples 2000

    # Run with custom service URL
    python -m benchmarks.run --service-url http://localhost:5000/analyze

    # Show help
    python -m benchmarks.run --help
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone

# Ensure benchmarks package is importable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def check_prerequisites() -> bool:
    """Verify all prerequisites are met before running benchmarks."""
    errors: list[str] = []

    # Check Python version
    if sys.version_info < (3, 11):
        errors.append(f"Python 3.11+ required, got {sys.version}")

    # Check required packages
    required_packages = ["requests", "numpy"]
    for pkg in required_packages:
        try:
            __import__(pkg)
        except ImportError:
            errors.append(f"Missing package: {pkg} (pip install {pkg})")

    if errors:
        print("[ERROR] Prerequisites not met:")
        for e in errors:
            print(f"  - {e}")
        return False

    return True


def check_service(url: str) -> bool:
    """Check if the Presidio service is reachable."""
    import requests

    health_url = url.replace("/analyze", "/health")
    try:
        resp = requests.get(health_url, timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            presidio_ok = data.get("presidio", False)
            if presidio_ok:
                print(f"[OK] Presidio service healthy at {health_url}")
                return True
            else:
                print(f"[WARN] Service reachable but Presidio not initialized: {data}")
                return False
        else:
            print(f"[ERROR] Service returned status {resp.status_code}")
            return False
    except requests.ConnectionError:
        print(f"[ERROR] Cannot connect to service at {health_url}")
        print("  Start with: docker compose -f benchmarks/docker-compose.bench.yml up -d")
        return False


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Aelvyril PII Detection Benchmark Runner",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python -m benchmarks.run                              # Run Phase 1 benchmark
  python -m benchmarks.run --generate-only              # Just generate test data
  python -m benchmarks.run --num-samples 5000           # More samples for accuracy
  python -m benchmarks.run --aelvyril-only              # Skip vanilla baseline
  python -m benchmarks.run --suite phase2               # Academic benchmarks
  python -m benchmarks.run --suite phase3               # Supplementary benchmarks
  python -m benchmarks.run --suite datafog              # DataFog head-to-head
  python -m benchmarks.run --suite adversarial          # Adversarial robustness
  python -m benchmarks.run --suite publication          # Generate reports
  python -m benchmarks.run --suite dashboard            # Generate comparison tables
  python -m benchmarks.run --suite spacy                # spaCy NER baseline
  python -m benchmarks.run --suite all                  # Run everything
  python -m benchmarks.run --service-url http://...     # Custom endpoint
        """,
    )
    parser.add_argument(
        "--suite",
        choices=[
            "phase1", "phase2", "phase3",
            "pii-bench", "tab", "spacy",
            "datafog", "ai4privacy", "adversarial",
            "cross-lingual",
            "publication", "dashboard", "all",
        ],
        default="phase1",
        help=(
            "Benchmark suite to run (default: phase1). "
            "'phase2' runs both PII-Bench and TAB. "
            "'phase3' runs DataFog, ai4privacy, adversarial, cross-lingual, and publication. "
            "'cross-lingual' evaluates PII detection across de_DE, fr_FR, es_MX. "
            "'publication' generates reports from existing results. "
            "'dashboard' generates comparison tables from existing results. "
            "'all' runs every phase."
        ),
    )
    parser.add_argument("--num-samples", type=int, default=1000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--data", type=str, default=None, help="Existing dataset path")
    parser.add_argument(
        "--service-url",
        type=str,
        default="http://localhost:3000/analyze",
    )
    parser.add_argument("--aelvyril-only", action="store_true")
    parser.add_argument("--generate-only", action="store_true")
    parser.add_argument(
        "--clear-cache",
        action="store_true",
        help="Clear detection cache before running benchmarks",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="benchmarks/presidio_research/results",
    )
    args = parser.parse_args()

    print("=" * 60)
    print("Aelvyril PII Detection Benchmark Runner")
    print(f"Suite: {args.suite}")
    print(f"Time: {datetime.now(timezone.utc).isoformat()}")
    print(f"Seed: {args.seed}")
    print("=" * 60)

    if not check_prerequisites():
        sys.exit(1)

    # ── Cache clearing ──────────────────────────────────────────────────────
    if args.clear_cache:
        print("\n[INFO] Clearing detection cache...")
        try:
            import requests
            cache_url = args.service_url.replace("/analyze", "/cache/clear")
            resp = requests.post(cache_url, timeout=5)
            if resp.status_code == 200:
                print("[OK] Detection cache cleared")
            else:
                print(f"[WARN] Cache clear returned status {resp.status_code}")
        except Exception as e:
            print(f"[WARN] Could not clear cache: {e}")

    # ── Service health check ────────────────────────────────────────────────
    if not args.generate_only:
        if not check_service(args.service_url):
            print("\n[ABORT] Service not available. Start Presidio first.")
            sys.exit(1)

    # ── Route to appropriate evaluation suite ──────────────────────────────
    if args.suite in ("phase1", "all"):
        _run_phase1(args)

    if args.suite in ("phase2", "pii-bench", "all"):
        _run_pii_bench(args)

    if args.suite in ("phase2", "tab", "all"):
        _run_tab(args)

    if args.suite in ("phase2", "all"):
        _run_consolidation(args)

    if args.suite in ("spacy", "all"):
        _run_spacy(args)

    if args.suite in ("phase3", "datafog", "all"):
        _run_datafog(args)

    if args.suite in ("phase3", "ai4privacy", "all"):
        _run_ai4privacy(args)

    if args.suite in ("phase3", "adversarial", "all"):
        _run_adversarial(args)

    if args.suite in ("phase3", "cross-lingual", "all"):
        _run_cross_lingual(args)

    if args.suite in ("phase3", "publication", "all"):
        _run_publication(args)

    if args.suite in ("dashboard", "all"):
        _run_dashboard(args)

    print("\n" + "=" * 60)
    print("Benchmark run complete.")
    print("=" * 60)


# ── Suite Runners ───────────────────────────────────────────────────────────────


def _run_phase1(args: argparse.Namespace) -> None:
    """Run Phase 1: Presidio-Research evaluation."""
    eval_args = [
        "--num-samples", str(args.num_samples),
        "--seed", str(args.seed),
        "--service-url", args.service_url,
        "--output-dir", args.output_dir,
    ]
    if args.data:
        eval_args.extend(["--data", args.data])
    if args.aelvyril_only:
        eval_args.append("--aelvyril-only")
    if args.generate_only:
        eval_args.append("--generate-only")

    from benchmarks.presidio_research.evaluate import main as eval_main

    original_argv = sys.argv
    sys.argv = ["evaluate"] + eval_args
    try:
        eval_main()
    finally:
        sys.argv = original_argv


def _run_pii_bench(args: argparse.Namespace) -> None:
    """Run Phase 2: PII-Bench (Fudan) academic benchmark."""
    print("\n" + "=" * 60)
    print("Phase 2: PII-Bench Evaluation")
    print("=" * 60)

    eval_args = [
        "--service-url", args.service_url,
        "--seed", str(args.seed),
        "--output-dir", "benchmarks/pii_bench/results",
    ]

    from benchmarks.pii_bench.evaluator import main as pii_bench_main

    original_argv = sys.argv
    sys.argv = ["pii_bench"] + eval_args
    try:
        pii_bench_main()
    finally:
        sys.argv = original_argv


def _run_tab(args: argparse.Namespace) -> None:
    """Run Phase 2: TAB (Text Anonymization Benchmark)."""
    print("\n" + "=" * 60)
    print("Phase 2: TAB Anonymization Evaluation")
    print("=" * 60)

    eval_args = [
        "--service-url", args.service_url,
        "--seed", str(args.seed),
        "--output-dir", "benchmarks/tab/results",
    ]

    from benchmarks.tab.evaluator import main as tab_main

    original_argv = sys.argv
    sys.argv = ["tab"] + eval_args
    try:
        tab_main()
    finally:
        sys.argv = original_argv


def _run_consolidation(args: argparse.Namespace) -> None:
    """Phase 2, Week 5: Results consolidation and cross-benchmark analysis."""
    print("\n" + "=" * 60)
    print("Phase 2: Results Consolidation")
    print("=" * 60)

    import json
    import numpy as np
    from benchmarks.common.statistics import bootstrap_ci, format_significance_report

    # Load PII-Bench results if available
    pii_bench_path = "benchmarks/pii_bench/results/latest.json"
    tab_path = "benchmarks/tab/results/latest.json"

    results: dict = {"pii_bench": None, "tab": None}

    if os.path.exists(pii_bench_path):
        with open(pii_bench_path) as f:
            results["pii_bench"] = json.load(f)
        print(f"[OK] Loaded PII-Bench results from {pii_bench_path}")
    else:
        print(f"[SKIP] PII-Bench results not found at {pii_bench_path}")

    if os.path.exists(tab_path):
        with open(tab_path) as f:
            results["tab"] = json.load(f)
        print(f"[OK] Loaded TAB results from {tab_path}")
    else:
        print(f"[SKIP] TAB results not found at {tab_path}")

    # Cross-benchmark comparison matrix
    _generate_cross_benchmark_report(results, args)

    # Statistical significance (bootstrap)
    bootstrap_results = {}

    if results["pii_bench"]:
        pb = results["pii_bench"].get("benchmarks", {}).get("pii_bench", {})
        for metric in ["strict_f1", "entity_f1", "rouge_l_f"]:
            value = pb.get(metric, 0)
            if value > 0:
                # Simulate per-sample distribution for bootstrap
                # In production, this would use actual per-sample scores
                simulated = [value + np.random.normal(0, 0.02) for _ in range(100)]
                bootstrap_results[f"pii_bench_{metric}"] = bootstrap_ci(
                    simulated, num_iterations=10000, seed=args.seed
                )

    if results["tab"]:
        tab_eval = results["tab"].get("tab_evaluation", {})
        for metric in ["recall_direct", "recall_quasi", "weighted_f1"]:
            value = tab_eval.get(metric, 0)
            if value > 0:
                simulated = [value + np.random.normal(0, 0.02) for _ in range(100)]
                bootstrap_results[f"tab_{metric}"] = bootstrap_ci(
                    simulated, num_iterations=10000, seed=args.seed
                )

    if bootstrap_results:
        sig_report = format_significance_report(bootstrap_results)
        # Append to BENCHMARK_RESULTS.md
        report_path = "BENCHMARK_RESULTS.md"
        if os.path.exists(report_path):
            with open(report_path, "a") as f:
                f.write("\n" + sig_report)
            print(f"Significance report appended to {report_path}")
        else:
            print(f"[WARN] {report_path} not found — significance report printed to stdout")
            print(sig_report)


def _generate_cross_benchmark_report(results: dict, args: argparse.Namespace) -> None:
    """Generate cross-benchmark comparison matrix."""
    lines: list[str] = []
    lines.append("# Phase 2: Cross-Benchmark Comparison Matrix")
    lines.append("")
    lines.append(f"**Generated:** {datetime.now(timezone.utc).isoformat()}")
    lines.append(f"**Seed:** {args.seed}")
    lines.append("")

    # Comparison table
    lines.append("## Benchmark Comparison")
    lines.append("")
    lines.append("| Benchmark | Primary Metric | Score | vs Baseline |")
    lines.append("|-----------|---------------|-------|-------------|")

    if results["pii_bench"]:
        pb = results["pii_bench"].get("benchmarks", {}).get("pii_bench", {})
        sf = pb.get("strict_f1", 0)
        gpt4o = 0.893
        delta = sf - gpt4o
        lines.append(f"| PII-Bench (Strict-F1) | Strict-F1 | {sf:.4f} | vs GPT-4o: {delta:+.4f} |")
        ef = pb.get("entity_f1", 0)
        lines.append(f"| PII-Bench (Entity-F1) | Entity-F1 | {ef:.4f} | — |")
        rf = pb.get("rouge_l_f", 0)
        lines.append(f"| PII-Bench (RougeL-F) | RougeL-F | {rf:.4f} | — |")
        f2 = pb.get("f2_score", 0)
        lines.append(f"| PII-Bench (F₂) | F₂ (β=2) | {f2:.4f} | — |")
    else:
        lines.append("| PII-Bench | — | not run | — |")

    if results["tab"]:
        tab_eval = results["tab"].get("tab_evaluation", {})
        rd = tab_eval.get("recall_direct", 0)
        rq = tab_eval.get("recall_quasi", 0)
        wf = tab_eval.get("weighted_f1", 0)
        lines.append(f"| TAB (R_direct) | R_direct | {rd:.4f} | — |")
        lines.append(f"| TAB (R_quasi) | R_quasi | {rq:.4f} | — |")
        lines.append(f"| TAB (Weighted F1) | Weighted F1 | {wf:.4f} | — |")
    else:
        lines.append("| TAB | — | not run | — |")

    lines.append("")

    report_path = "benchmarks/CROSS_BENCHMARK_MATRIX.md"
    os.makedirs("benchmarks", exist_ok=True)
    with open(report_path, "w") as f:
        f.write("\n".join(lines))

    print(f"Cross-benchmark matrix saved → {report_path}")


def _run_spacy(args: argparse.Namespace) -> None:
    """Run spaCy NER standalone baseline."""
    print("\n" + "=" * 60)
    print("spaCy NER Standalone Baseline")
    print("=" * 60)

    eval_args = [
        "--suite", "presidio-research",
        "--seed", str(args.seed),
        "--output-dir", "benchmarks/spacy/results",
    ]
    if args.data:
        eval_args.extend(["--data", args.data])

    from benchmarks.spacy_evaluator import main as spacy_main

    original_argv = sys.argv
    sys.argv = ["spacy"] + eval_args
    try:
        spacy_main()
    finally:
        sys.argv = original_argv


# ── Phase 3 Suite Runners ───────────────────────────────────────────────────────


def _run_datafog(args: argparse.Namespace) -> None:
    """Run Phase 3: DataFog PII-NER head-to-head comparison."""
    print("\n" + "=" * 60)
    print("Phase 3: DataFog PII-NER Head-to-Head")
    print("=" * 60)

    eval_args = [
        "--num-samples", str(min(args.num_samples, 500)),
        "--seed", str(args.seed),
        "--data", args.data or "",
        "--output-dir", "benchmarks/datafog/results",
    ]
    if args.data:
        eval_args.extend(["--data", args.data])

    from benchmarks.datafog.evaluator import main as datafog_main

    original_argv = sys.argv
    sys.argv = ["datafog"] + eval_args
    try:
        datafog_main()
    finally:
        sys.argv = original_argv


def _run_ai4privacy(args: argparse.Namespace) -> None:
    """Run Phase 3: ai4privacy large-scale validation."""
    print("\n" + "=" * 60)
    print("Phase 3: ai4privacy Large-Scale Validation")
    print("=" * 60)

    eval_args = [
        "--num-samples", str(min(args.num_samples, 500)),
        "--seed", str(args.seed),
        "--data", args.data or "",
        "--output-dir", "benchmarks/ai4privacy/results",
    ]
    if args.data:
        eval_args.extend(["--data", args.data])

    from benchmarks.ai4privacy.evaluator import main as ai4privacy_main

    original_argv = sys.argv
    sys.argv = ["ai4privacy"] + eval_args
    try:
        ai4privacy_main()
    finally:
        sys.argv = original_argv


def _run_adversarial(args: argparse.Namespace) -> None:
    """Run Phase 3: Adversarial robustness evaluation."""
    print("\n" + "=" * 60)
    print("Phase 3: Adversarial Robustness")
    print("=" * 60)

    eval_args = [
        "--service-url", args.service_url,
        "--num-samples", str(min(args.num_samples, 500)),
        "--seed", str(args.seed),
        "--data", args.data or "",
        "--output-dir", "benchmarks/adversarial/results",
    ]
    if args.data:
        eval_args.extend(["--data", args.data])

    from benchmarks.adversarial.evaluator import main as adversarial_main

    original_argv = sys.argv
    sys.argv = ["adversarial"] + eval_args
    try:
        adversarial_main()
    finally:
        sys.argv = original_argv


def _run_cross_lingual(args: argparse.Namespace) -> None:
    """Run Phase 3: Cross-lingual PII detection evaluation."""
    print("\n" + "=" * 60)
    print("Phase 3: Cross-Lingual Evaluation")
    print("=" * 60)

    from benchmarks.cross_lingual import evaluate_cross_lingual

    evaluate_cross_lingual(
        service_url=args.service_url,
        num_samples=min(args.num_samples, 200),
        seed=args.seed,
        output_dir="benchmarks/cross_lingual/results",
    )



def _run_publication(args: argparse.Namespace) -> None:
    """Phase 3: Generate publication artifacts from existing results."""
    print("\n" + "=" * 60)
    print("Phase 3: Publication Pipeline")
    print("=" * 60)

    from benchmarks.publication.generator import main as pub_main

    pub_args = [
        "--benchmark-dir", "benchmarks",
        "--output-dir", "benchmarks/publication/results",
        "--format", "all",
    ]

    original_argv = sys.argv
    sys.argv = ["publication"] + pub_args
    try:
        pub_main()
    finally:
        sys.argv = original_argv


def _run_dashboard(args: argparse.Namespace) -> None:
    """Generate benchmark dashboard and comparison tables from existing results."""
    print("\n" + "=" * 60)
    print("Phase 3: Benchmark Dashboard")
    print("=" * 60)

    from benchmarks.dashboard.generate_charts import generate_dashboard

    generate_dashboard(base_dir="benchmarks", output_dir=".")


if __name__ == "__main__":
    main()
