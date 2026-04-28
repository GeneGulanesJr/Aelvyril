"""
Benchmark dashboard generator — creates Markdown comparison tables and charts.

Generates:
    1. BENCHMARK_COMPARISON.md — Publication-ready comparison table
    2. latest.json — Machine-readable aggregated results
    3. Console summary with key metrics

Usage:
    python -m benchmarks.dashboard.generate_charts
    python -m benchmarks.dashboard.generate_charts --output-dir benchmarks
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))


# ── Target Benchmark Table ──────────────────────────────────────────────────────

TARGET_TABLE: List[Dict[str, Any]] = [
    {
        "pii_type": "SSN",
        "target_recall": 0.99,
        "target_precision": 0.99,
        "target_f2": 0.99,
        "priority": "P0",
        "source": "Custom regex + Presidio",
    },
    {
        "pii_type": "Credit Card",
        "target_recall": 0.98,
        "target_precision": 0.96,
        "target_f2": 0.95,
        "priority": "P0",
        "source": "Custom regex + Luhn",
    },
    {
        "pii_type": "Email",
        "target_recall": 0.99,
        "target_precision": 0.99,
        "target_f2": 0.99,
        "priority": "P0",
        "source": "Custom regex + Presidio",
    },
    {
        "pii_type": "Phone",
        "target_recall": 0.98,
        "target_precision": 0.97,
        "target_f2": 0.97,
        "priority": "P0",
        "source": "Custom regex (tuned)",
    },
    {
        "pii_type": "IBAN",
        "target_recall": 0.99,
        "target_precision": 0.99,
        "target_f2": 0.99,
        "priority": "P0",
        "source": "Custom regex + checksum",
    },
    {
        "pii_type": "IP Address",
        "target_recall": 0.96,
        "target_precision": 0.95,
        "target_f2": 0.95,
        "priority": "P1",
        "source": "Custom regex + context filter",
    },
    {
        "pii_type": "Person",
        "target_recall": 0.96,
        "target_precision": 0.93,
        "target_f2": 0.94,
        "priority": "P1",
        "presidio_baseline_f2": 0.63,
        "gpt4o_f1": 0.998,
        "source": "Presidio NER passthrough",
    },
    {
        "pii_type": "Location",
        "target_recall": 0.85,
        "target_precision": 0.88,
        "target_f2": 0.85,
        "priority": "P2",
        "presidio_baseline_f2": 0.23,
        "gpt4o_f1": 0.769,
        "source": "Presidio NER passthrough",
    },
    {
        "pii_type": "Organization",
        "target_recall": 0.75,
        "target_precision": 0.80,
        "target_f2": 0.76,
        "priority": "P2",
        "presidio_baseline_f2": None,
        "gpt4o_f1": 0.604,
        "source": "Presidio NER passthrough",
    },
    {
        "pii_type": "API Key",
        "target_recall": 0.90,
        "target_precision": 0.85,
        "target_f2": 0.88,
        "priority": "P1",
        "source": "Custom regex (synthetic eval only)",
    },
    {
        "pii_type": "Domain",
        "target_recall": 0.88,
        "target_precision": 0.90,
        "target_f2": 0.88,
        "priority": "P2",
        "source": "Custom regex (synthetic eval only)",
    },
    {
        "pii_type": "Date",
        "target_recall": 0.85,
        "target_precision": 0.88,
        "target_f2": 0.86,
        "priority": "P3",
        "source": "Custom regex (synthetic eval only)",
    },
    {
        "pii_type": "Zip Code",
        "target_recall": 0.85,
        "target_precision": 0.90,
        "target_f2": 0.86,
        "priority": "P3",
        "source": "Custom regex (synthetic eval only)",
    },
]


def load_result_file(path: str) -> Optional[Dict]:
    """Load a JSON result file, returning None if not found."""
    if not os.path.exists(path):
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        print(f"[WARN] Could not load {path}: {e}")
        return None


def collect_all_results(base_dir: str = "benchmarks") -> Dict[str, Any]:
    """Collect results from all benchmark suites.

    Returns:
        Dict with keys for each benchmark suite's results.
    """
    results: Dict[str, Any] = {}

    # Phase 1: Presidio-Research
    phase1_path = os.path.join(base_dir, "presidio_research", "results", "latest.json")
    phase1 = load_result_file(phase1_path)
    results["presidio_research"] = phase1

    # Phase 2: PII-Bench
    pii_bench_path = os.path.join(base_dir, "pii_bench", "results", "latest.json")
    pii_bench = load_result_file(pii_bench_path)
    results["pii_bench"] = pii_bench

    # Phase 2: TAB
    tab_path = os.path.join(base_dir, "tab", "results", "latest.json")
    tab = load_result_file(tab_path)
    results["tab"] = tab

    # Phase 3: Supplementary
    datafog_path = os.path.join(base_dir, "supplementary", "results", "datafog_latest.json")
    results["datafog"] = load_result_file(datafog_path)

    ai4privacy_path = os.path.join(base_dir, "supplementary", "results", "ai4privacy_latest.json")
    results["ai4privacy"] = load_result_file(ai4privacy_path)

    adversarial_path = os.path.join(base_dir, "supplementary", "results", "adversarial_latest.json")
    results["adversarial"] = load_result_file(adversarial_path)

    # spaCy NER standalone baseline
    spacy_path = os.path.join(base_dir, "spacy", "results", "latest.json")
    results["spacy"] = load_result_file(spacy_path)

    # Cross-lingual
    cross_lingual_path = os.path.join(base_dir, "cross_lingual", "results", "latest.json")
    results["cross_lingual"] = load_result_file(cross_lingual_path)

    return results


def generate_comparison_table(
    results: Dict[str, Any],
) -> str:
    """Generate the publication-ready BENCHMARK_COMPARISON.md.

    Combines actual results (where available) with target benchmarks
    to create a comprehensive comparison table.
    """
    lines: List[str] = []
    now = datetime.now(timezone.utc).isoformat()

    lines.append("# Aelvyril PII Detection — Benchmark Comparison")
    lines.append("")
    lines.append(f"**Generated:** {now}")
    lines.append(f"**Primary Metric:** F₂ (β=2, recall-weighted)")
    lines.append(f"**Philosophy:** Missing PII is worse than over-redaction")
    lines.append("")

    # ── Executive Summary ────────────────────────────────────────────────
    lines.append("## Executive Summary")
    lines.append("")

    # Pull key metrics from results
    phase1 = results.get("presidio_research")
    pii_bench = results.get("pii_bench")
    tab = results.get("tab")
    adversarial = results.get("adversarial")

    summary_metrics: List[str] = []
    if phase1:
        agg = phase1.get("aggregate", {})
        f2 = agg.get("f2", 0)
        if f2:
            summary_metrics.append(f"- **F₂ Score (Presidio-Research):** {f2:.4f}")

    if pii_bench:
        pb = pii_bench.get("benchmarks", {}).get("pii_bench", {})
        sf = pb.get("strict_f1", 0)
        if sf:
            summary_metrics.append(f"- **Strict-F1 (Nemotron-PII):** {sf:.4f}")

    if tab:
        te = tab.get("tab_evaluation", {})
        rd = te.get("recall_direct", 0)
        if rd:
            summary_metrics.append(f"- **R_direct (TAB):** {rd:.4f}")

    if adversarial:
        ar = adversarial.get("results", {})
        rob = ar.get("overall_robustness", 0)
        if rob:
            summary_metrics.append(f"- **Adversarial Robustness:** {rob:.4f}")

    spacy = results.get("spacy")
    if spacy:
        sr = spacy.get("spacy_evaluation", {})
        sf = sr.get("strict_f1", 0)
        if sf:
            summary_metrics.append(f"- **Strict-F1 (spaCy NER baseline):** {sf:.4f}")

    if summary_metrics:
        lines.extend(summary_metrics)
    else:
        lines.append("_No benchmark results available yet. Run benchmarks to populate this section._")
    lines.append("")

    # ── Target Benchmark Table ───────────────────────────────────────────
    lines.append("## Target Benchmark Table")
    lines.append("")
    lines.append(
        "| PII Type | Aelvyril Recall | Aelvyril Precision | Aelvyril F₂ | "
        "Presidio Baseline F₂ | spaCy NER F₂ | GPT-4o F1 (PII-Bench) | Priority | Source |"
    )
    lines.append(
        "|----------|-----------------|--------------------|-------------|"
        "----------------------|--------------|-----------------------|----------|--------|"
    )

    for row in TARGET_TABLE:
        # Try to fill in actual results
        recall_str = f"≥{row['target_recall']:.0%}" if row['target_recall'] >= 1 else f"≥{row['target_recall']:.0%}"
        precision_str = f"≥{row['target_precision']:.0%}" if row['target_precision'] >= 1 else f"≥{row['target_precision']:.0%}"
        f2_str = f"≥{row['target_f2']:.2f}"

        # Check if we have actual results from Phase 1
        actual_recall = ""
        actual_precision = ""
        actual_f2 = ""

        if phase1:
            per_entity = phase1.get("per_entity", {})
            for entity_type, metrics in per_entity.items():
                if row["pii_type"].upper().replace(" ", "_") in entity_type.upper():
                    actual_recall = f"{metrics.get('recall', 0):.2%}"
                    actual_precision = f"{metrics.get('precision', 0):.2%}"
                    actual_f2 = f"{metrics.get('f2', 0):.2f}"
                    break

        if actual_f2:
            recall_str = actual_recall
            precision_str = actual_precision
            f2_str = actual_f2

        presidio_baseline = row.get("presidio_baseline_f2")
        pb_str = f"{presidio_baseline:.2f}" if presidio_baseline is not None else "—"

        spacy_f2 = None
        if spacy and row["pii_type"] in ("Person", "Location", "Organization"):
            per_entity = spacy.get("spacy_evaluation", {}).get("per_entity", {})
            for entity_type, metrics in per_entity.items():
                if row["pii_type"].upper().replace(" ", "_") in entity_type.upper():
                    spacy_f2 = metrics.get("f2")
                    break
        spacy_str = f"{spacy_f2:.2f}" if spacy_f2 is not None else "—"

        gpt4o_f1 = row.get("gpt4o_f1")
        gpt4o_str = f"{gpt4o_f1:.3f}" if gpt4o_f1 is not None else "—"

        lines.append(
            f"| **{row['pii_type']}** | {recall_str} | {precision_str} | {f2_str} | "
            f"{pb_str} | {spacy_str} | {gpt4o_str} | {row['priority']} | {row['source']} |"
        )
    lines.append("")

    lines.append("> Targets are from the Aelvyril benchmark plan. Actual results replace targets once benchmarks are run.")
    lines.append("> **†** Presidio baseline values are from presidio-research evaluation.")
    lines.append("> **‡** spaCy NER F₂ is a standalone baseline (no Presidio regex overlay).")
    lines.append("")

    # ── Nemotron-PII Results ─────────────────────────────────────────────
    lines.append("## Nemotron-PII Benchmark (NVIDIA, CC BY 4.0)")
    lines.append("")
    lines.append("| System | Strict-F1 | Entity-F1 | RougeL-F | Source |")
    lines.append("|--------|-----------|-----------|----------|--------|")

    if pii_bench:
        pb = pii_bench.get("benchmarks", {}).get("pii_bench", {})
        lines.append(
            f"| **Aelvyril** | **{pb.get('strict_f1', 0):.4f}** | "
            f"**{pb.get('entity_f1', 0):.4f}** | **{pb.get('rouge_l_f', 0):.4f}** | This work |"
        )
    else:
        lines.append("| **Aelvyril** | _pending_ | _pending_ | _pending_ | — |")
    lines.append("")

    # ── spaCy NER Baseline ────────────────────────────────────────────────
    lines.append("## spaCy NER Baseline (Standalone)")
    lines.append("")
    lines.append("| System | Strict-F1 | Entity-F1 | RougeL-F | Source |")
    lines.append("|--------|-----------|-----------|----------|--------|")

    if spacy:
        sr = spacy.get("spacy_evaluation", {})
        lines.append(
            f"| **spaCy NER (en_core_web_lg)** | **{sr.get('strict_f1', 0):.4f}** | "
            f"**{sr.get('entity_f1', 0):.4f}** | **{sr.get('rouge_l_f', 0):.4f}** | spaCy v3.x |"
        )
    else:
        lines.append("| **spaCy NER (en_core_web_lg)** | _pending_ | _pending_ | _pending_ | spaCy v3.x |")

    if pii_bench:
        pb = pii_bench.get("benchmarks", {}).get("pii_bench", {})
        lines.append(
            f"| Aelvyril (Nemotron-PII) | {pb.get('strict_f1', 0):.4f} | "
            f"{pb.get('entity_f1', 0):.4f} | {pb.get('rouge_l_f', 0):.4f} | This work |"
        )
    else:
        lines.append("| Aelvyril (same dataset) | _pending_ | _pending_ | _pending_ | — |")
    lines.append("")

    # ── TAB Anonymization ────────────────────────────────────────────────
    lines.append("## TAB Anonymization Quality (arxiv:2202.00443)")
    lines.append("")
    lines.append("| Metric | Value | Assessment |")
    lines.append("|--------|-------|------------|")

    if tab:
        te = tab.get("tab_evaluation", {})
        rd = te.get("recall_direct", 0)
        rq = te.get("recall_quasi", 0)
        wf = te.get("weighted_f1", 0)

        rd_assess = "✅ Low risk" if rd >= 0.95 else "⚠️ Moderate" if rd >= 0.85 else "❌ High risk"
        rq_assess = "✅ Low risk" if rq >= 0.80 else "⚠️ Moderate" if rq >= 0.65 else "❌ High risk"

        lines.append(f"| **R_direct** (must-mask recall) | {rd:.4f} | {rd_assess} |")
        lines.append(f"| **R_quasi** (should-mask recall) | {rq:.4f} | {rq_assess} |")
        lines.append(f"| **Weighted F1** | {wf:.4f} | — |")
    else:
        lines.append("| R_direct | _pending_ | — |")
        lines.append("| R_quasi | _pending_ | — |")
        lines.append("| Weighted F1 | _pending_ | — |")
    lines.append("")

    # ── Supplementary Benchmarks ─────────────────────────────────────────
    lines.append("## Supplementary Benchmarks")
    lines.append("")

    # DataFog comparison
    datafog = results.get("datafog")
    lines.append("### DataFog PII-NER (Head-to-Head)")
    lines.append("")
    if datafog:
        comp = datafog.get("results", {})
        lines.append("| System | F₁ | F₂ | Recall | Precision |")
        lines.append("|--------|-----|-----|--------|-----------|")
        lines.append(f"| **Aelvyril** | {comp.get('aelvyril', {}).get('f1', 0):.4f} | {comp.get('aelvyril', {}).get('f2', 0):.4f} | {comp.get('aelvyril', {}).get('recall', 0):.4f} | {comp.get('aelvyril', {}).get('precision', 0):.4f} |")
        lines.append(f"| DataFog PII-NER | {comp.get('datafog', {}).get('f1', 0):.4f} | {comp.get('datafog', {}).get('f2', 0):.4f} | {comp.get('datafog', {}).get('recall', 0):.4f} | {comp.get('datafog', {}).get('precision', 0):.4f} |")
        lines.append("")
        lines.append(f"**Δ F₁:** {comp.get('delta_f1', 0):+.4f}")
    else:
        lines.append("_DataFog comparison not yet run._")
    lines.append("")

    # ai4privacy
    ai4privacy = results.get("ai4privacy")
    lines.append("### ai4privacy/open-pii-masking-500k (Large-Scale)")
    lines.append("")
    if ai4privacy:
        ar = ai4privacy.get("results", {})
        lines.append("| Metric | Value |")
        lines.append("|--------|-------|")
        lines.append(f"| F₂ | {ar.get('f2_score', 0):.4f} |")
        lines.append(f"| F₁ | {ar.get('f1_score', 0):.4f} |")
        lines.append(f"| Recall | {ar.get('recall', 0):.4f} |")
        lines.append(f"| Precision | {ar.get('precision', 0):.4f} |")
        lines.append(f"| Samples | {ar.get('num_samples', 0)} |")
    else:
        lines.append("_ai4privacy evaluation not yet run._")
    lines.append("")

    # Adversarial robustness
    adv = results.get("adversarial")
    lines.append("### Adversarial Robustness")
    lines.append("")
    if adv:
        ar = adv.get("results", {})
        lines.append("| Category | Detection Rate (Original) | Detection Rate (Modified) | Robustness |")
        lines.append("|----------|--------------------------|--------------------------|------------|")
        for cat_name, cat_data in ar.get("categories", {}).items():
            lines.append(
                f"| {cat_name} | {cat_data.get('detection_rate_original', 0):.4f} "
                f"| {cat_data.get('detection_rate_modified', 0):.4f} "
                f"| {cat_data.get('robustness_score', 0):.4f} |"
            )
        lines.append("")
        lines.append(f"**Overall Robustness:** {ar.get('overall_robustness', 0):.4f}")
    else:
        lines.append("_Adversarial robustness evaluation not yet run._")
    lines.append("")

    # Cross-lingual results
    cross_lingual = results.get("cross_lingual")
    lines.append("### Cross-Lingual Detection")
    lines.append("")
    if cross_lingual:
        agg = cross_lingual.get("aggregate", {})
        lines.append(f"**Aggregate:** F₂={agg.get('f2', 0):.4f}, F₁={agg.get('f1', 0):.4f}, Recall={agg.get('recall', 0):.4f}")
        lines.append("")
        lines.append("| Locale | Samples | Precision | Recall | F₁ | F₂ |")
        lines.append("|--------|---------|-----------|--------|-----|-----|")
        for locale, data in cross_lingual.get("per_locale", {}).items():
            lines.append(
                f"| {locale} | {data.get('samples', 0)} | "
                f"{data.get('precision', 0):.4f} | {data.get('recall', 0):.4f} | "
                f"{data.get('f1', 0):.4f} | {data.get('f2', 0):.4f} |"
            )
        lines.append("")
    else:
        lines.append("_Cross-lingual evaluation not yet run._")
    lines.append("")

    # ── Methodology ──────────────────────────────────────────────────────
    lines.append("## Methodology")
    lines.append("")
    lines.append("- **F₂ (β=2):** Recall-weighted F-score — missing PII penalized 4× more than false positives")
    lines.append("- **Strict-F1:** Exact span match (start/end must match exactly)")
    lines.append("- **Entity-F1:** Token-level F1 with BIO tagging (partial overlap counted)")
    lines.append("- **RougeL-F:** LCS-based fuzzy matching (≥0.5 threshold)")
    lines.append("- **R_direct / R_quasi:** TAB masking decision recall (DIRECT = must mask, QUASI = should mask)")
    lines.append("- **Robustness:** Detection rate on adversarial input / detection rate on clean input")
    lines.append("- Statistical significance: Bootstrap resampling (10,000 iterations, 95% CI)")
    lines.append("- All runs use fixed seed=42, deterministic data generation")
    lines.append("")

    # ── Reproducibility ──────────────────────────────────────────────────
    lines.append("## Reproducibility")
    lines.append("")
    lines.append("```bash")
    lines.append("# Run all benchmarks")
    lines.append("python -m benchmarks.run --suite all")
    lines.append("")
    lines.append("# Generate this comparison table")
    lines.append("python -m benchmarks.dashboard.generate_charts")
    lines.append("")
    lines.append("# Start the benchmark stack")
    lines.append("docker compose -f benchmarks/docker-compose.bench.yml up -d")
    lines.append("```")
    lines.append("")
    lines.append("See `benchmarks/versions.lock` for pinned dependency versions and `benchmarks/BENCHMARK_METHODOLOGY.md` for full methodology.")
    lines.append("")

    return "\n".join(lines)


def generate_dashboard(
    base_dir: str = "benchmarks",
    output_dir: str = ".",
) -> str:
    """Generate the full benchmark dashboard (BENCHMARK_COMPARISON.md + latest.json).

    Args:
        base_dir: Base benchmarks directory.
        output_dir: Directory for output files.

    Returns:
        Path to the generated BENCHMARK_COMPARISON.md.
    """
    print("Collecting benchmark results...")
    results = collect_all_results(base_dir)

    # Count available results
    available = sum(1 for v in results.values() if v is not None)
    total = len(results)
    print(f"  Found {available}/{total} benchmark result files")

    # Generate comparison table
    comparison_md = generate_comparison_table(results)

    # Save Markdown
    md_path = os.path.join(output_dir, "BENCHMARK_COMPARISON.md")
    os.makedirs(output_dir, exist_ok=True)
    with open(md_path, "w") as f:
        f.write(comparison_md)
    print(f"BENCHMARK_COMPARISON.md saved → {md_path}")

    # Save aggregated JSON
    latest_json = {
        "aelvyril_version": "dev",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "benchmarks": {},
    }

    for name, data in results.items():
        if data:
            latest_json["benchmarks"][name] = data

    json_path = os.path.join(base_dir, "results", "latest.json")
    os.makedirs(os.path.dirname(json_path), exist_ok=True)
    with open(json_path, "w") as f:
        json.dump(latest_json, f, indent=2)
    print(f"Aggregated results saved → {json_path}")

    # Record run for trend tracking
    try:
        from benchmarks.dashboard.trends import TrendTracker
        tracker = TrendTracker(os.path.join(base_dir, "results"))
        tracker.record_run(latest_json)
        trends_md = tracker.generate_trends_report()

        # Append trends to comparison markdown
        with open(md_path, "a") as f:
            f.write("\n---\n\n")
            f.write(trends_md)
        print(f"Trends appended to {md_path}")
    except Exception as e:
        print(f"[WARN] Could not generate trends: {e}")

    # Print console summary
    print(f"\n{'='*60}")
    print("Benchmark Dashboard Summary")
    print(f"{'='*60}")
    print(f"Results available: {available}/{total}")

    for name, data in results.items():
        if data:
            print(f"  ✅ {name}")
        else:
            print(f"  ⬜ {name} (not run)")

    print(f"\nDashboard saved → {md_path}")
    return md_path


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Generate Benchmark Dashboard")
    parser.add_argument("--base-dir", type=str, default="benchmarks")
    parser.add_argument("--output-dir", type=str, default=".")
    args = parser.parse_args()

    generate_dashboard(args.base_dir, args.output_dir)


if __name__ == "__main__":
    main()
