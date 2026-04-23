#!/usr/bin/env python3
"""
One-shot benchmark orchestration script.

Runs all benchmark phases in order, generates dashboards, runs the publication
pipeline, and optionally updates versions.lock.

Usage:
    python benchmarks/run_all.py
    python benchmarks/run_all.py --skip-phase1          # Skip Presidio-Research
    python benchmarks/run_all.py --skip-phase2          # Skip PII-Bench + TAB
    python benchmarks/run_all.py --skip-phase3          # Skip supplementary
    python benchmarks/run_all.py --skip-spacy           # Skip spaCy baseline
    python benchmarks/run_all.py --skip-publication     # Skip report generation
    python benchmarks/run_all.py --update-versions      # Update versions.lock
    python benchmarks/run_all.py --service-url http://... # Custom endpoint
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

# Ensure benchmarks package is importable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _run_module(module: str, args: list[str]) -> int:
    """Run a Python module with the given args and return exit code."""
    cmd = [sys.executable, "-m", module] + args
    print(f"\n[RUN] {' '.join(cmd)}")
    start = time.time()
    result = subprocess.run(cmd)
    elapsed = time.time() - start
    print(f"[DONE] {module} in {elapsed:.1f}s (exit {result.returncode})")
    return result.returncode


def main() -> None:
    parser = argparse.ArgumentParser(description="One-shot Aelvyril benchmark orchestration")
    parser.add_argument("--service-url", type=str, default="http://localhost:3000/analyze")
    parser.add_argument("--num-samples", type=int, default=1000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--data", type=str, default=None)
    parser.add_argument("--skip-phase1", action="store_true", help="Skip Presidio-Research")
    parser.add_argument("--skip-phase2", action="store_true", help="Skip PII-Bench + TAB")
    parser.add_argument("--skip-phase3", action="store_true", help="Skip supplementary benchmarks")
    parser.add_argument("--skip-spacy", action="store_true", help="Skip spaCy baseline")
    parser.add_argument("--skip-publication", action="store_true", help="Skip report generation")
    parser.add_argument("--update-versions", action="store_true", help="Update versions.lock")
    parser.add_argument("--clear-cache", action="store_true", help="Clear detection cache first")
    args = parser.parse_args()

    print("=" * 70)
    print("Aelvyril PII Detection — Full Benchmark Orchestration")
    print(f"Started: {datetime.now(timezone.utc).isoformat()}")
    print("=" * 70)

    total_start = time.time()
    failures: list[str] = []

    # ── Optional: Update versions.lock ───────────────────────────────────────
    if args.update_versions:
        rc = _run_module("benchmarks.scripts.generate_versions_lock", [])
        if rc != 0:
            failures.append("versions.lock update")

    # ── Phase 1 ──────────────────────────────────────────────────────────────
    if not args.skip_phase1:
        phase1_args = [
            "--suite", "phase1",
            "--service-url", args.service_url,
            "--num-samples", str(args.num_samples),
            "--seed", str(args.seed),
        ]
        if args.data:
            phase1_args.extend(["--data", args.data])
        if args.clear_cache:
            phase1_args.append("--clear-cache")
        rc = _run_module("benchmarks.run", phase1_args)
        if rc != 0:
            failures.append("phase1")

    # ── Phase 2 ──────────────────────────────────────────────────────────────
    if not args.skip_phase2:
        phase2_args = [
            "--suite", "phase2",
            "--service-url", args.service_url,
            "--seed", str(args.seed),
        ]
        if args.data:
            phase2_args.extend(["--data", args.data])
        rc = _run_module("benchmarks.run", phase2_args)
        if rc != 0:
            failures.append("phase2")

    # ── spaCy baseline ───────────────────────────────────────────────────────
    if not args.skip_spacy:
        spacy_args = [
            "--suite", "spacy",
            "--seed", str(args.seed),
        ]
        if args.data:
            spacy_args.extend(["--data", args.data])
        rc = _run_module("benchmarks.run", spacy_args)
        if rc != 0:
            failures.append("spacy")

    # ── Phase 3 ──────────────────────────────────────────────────────────────
    if not args.skip_phase3:
        phase3_args = [
            "--suite", "phase3",
            "--service-url", args.service_url,
            "--num-samples", str(args.num_samples),
            "--seed", str(args.seed),
        ]
        if args.data:
            phase3_args.extend(["--data", args.data])
        rc = _run_module("benchmarks.run", phase3_args)
        if rc != 0:
            failures.append("phase3")

    # ── Dashboard ────────────────────────────────────────────────────────────
    rc = _run_module("benchmarks.run", ["--suite", "dashboard"])
    if rc != 0:
        failures.append("dashboard")

    # ── Publication ──────────────────────────────────────────────────────────
    if not args.skip_publication:
        pub_args = [
            "--suite", "publication",
            "--service-url", args.service_url,
        ]
        rc = _run_module("benchmarks.run", pub_args)
        if rc != 0:
            failures.append("publication")

    total_elapsed = time.time() - total_start

    print("\n" + "=" * 70)
    print("Benchmark Orchestration Complete")
    print(f"Total time: {total_elapsed:.1f}s")
    if failures:
        print(f"Failures: {', '.join(failures)}")
        sys.exit(1)
    else:
        print("All phases completed successfully.")
        print("\nDeliverables:")
        print("  - BENCHMARK_COMPARISON.md")
        print("  - BENCHMARK_RESULTS.md")
        print("  - ERROR_ANALYSIS.md")
        print("  - benchmarks/publication/results/arxiv_report.md")
        print("  - benchmarks/publication/results/*.tex")
        print("  - benchmarks/results/latest.json")
    print("=" * 70)


if __name__ == "__main__":
    main()
