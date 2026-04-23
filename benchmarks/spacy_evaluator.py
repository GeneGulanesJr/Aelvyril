"""
spaCy NER standalone evaluator — baseline comparison against raw spaCy.

Evaluates spaCy's built-in NER model (en_core_web_lg) directly on benchmark
datasets, without Presidio's wrapper or custom recognizers. This establishes
a fair lower bound for NER-heavy entity types (PERSON, ORG, LOC, DATE).

Usage:
    python -m benchmarks.spacy_evaluator --data benchmarks/data/synthetic_llm_prompts.json
    python -m benchmarks.spacy_evaluator --suite pii-bench
    python -m benchmarks.spacy_evaluator --suite tab

Output:
    benchmarks/spacy/results/spacy_baseline.json
    benchmarks/spacy/results/SPACY_BASELINE.md
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from benchmarks.common.metrics import (
    EntityMetrics,
    SpanMatch,
    compute_aggregate,
    evaluate_entity_types,
)
from benchmarks.common.reporting import format_results_as_markdown, save_results_json
from benchmarks.common.utils import set_seeds

# spaCy entity type → Aelvyril/Presidio entity type mapping
SPACY_ENTITY_MAP: Dict[str, str] = {
    "PERSON": "Person",
    "PER": "Person",
    "ORG": "Organization",
    "ORGANIZATION": "Organization",
    "GPE": "Location",
    "LOC": "Location",
    "FAC": "Location",
    "DATE": "Date",
    "TIME": "Date",
    "CARDINAL": "Zip_Code",  # Often numbers; weak mapping
    "MONEY": "Credit_Card",  # Weak mapping
    "EMAIL": "Email",
    "PHONE": "Phone",
}


def load_spacy_model(model_name: str = "en_core_web_lg"):
    """Load spaCy NER model, with graceful fallback."""
    try:
        import spacy
        try:
            nlp = spacy.load(model_name)
            print(f"[OK] Loaded spaCy model: {model_name}")
            return nlp
        except OSError:
            print(f"[WARN] {model_name} not found. Trying en_core_web_sm...")
            nlp = spacy.load("en_core_web_sm")
            print("[OK] Loaded spaCy model: en_core_web_sm")
            return nlp
    except ImportError:
        print("[ERROR] spaCy not installed. Install with: pip install spacy")
        print("  Then download model: python -m spacy download en_core_web_lg")
        sys.exit(1)


def run_spacy_on_text(
    nlp,
    text: str,
    score: float = 0.85,
) -> List[SpanMatch]:
    """Run spaCy NER on a single text and return matched spans."""
    doc = nlp(text)
    spans: List[SpanMatch] = []
    for ent in doc.ents:
        mapped = SPACY_ENTITY_MAP.get(ent.label_, ent.label_)
        spans.append(
            SpanMatch(
                entity_type=mapped,
                start=ent.start_char,
                end=ent.end_char,
                text=ent.text,
                score=score,
            )
        )
    return spans


def run_spacy_evaluation(
    samples: List[dict],
    nlp,
) -> Dict[str, EntityMetrics]:
    """Run spaCy NER evaluation on a dataset."""
    all_predicted: List[SpanMatch] = []
    all_gold: List[SpanMatch] = []

    print(f"\n{'='*60}")
    print("Running spaCy NER Baseline Evaluation...")
    print(f"{'='*60}")

    for i, sample in enumerate(samples):
        text = sample["text"]
        gold_spans = [
            SpanMatch(
                entity_type=s.get("entity_type", "UNKNOWN"),
                start=s["start"],
                end=s["end"],
                text=s.get("text", ""),
            )
            for s in sample.get("spans", [])
        ]

        pred_spans = run_spacy_on_text(nlp, text)

        all_predicted.extend(pred_spans)
        all_gold.extend(gold_spans)

        if (i + 1) % 200 == 0:
            print(f"  Processed {i + 1}/{len(samples)} samples...")

    print(f"  Processed {len(samples)}/{len(samples)} samples.")
    return evaluate_entity_types(all_predicted, all_gold)


def generate_spacy_report(
    metrics: Dict[str, EntityMetrics],
    agg: EntityMetrics,
    output_dir: str,
) -> str:
    """Generate SPACY_BASELINE.md report."""
    md = format_results_as_markdown(
        metrics,
        agg,
        title="spaCy NER Standalone Baseline Results",
    )

    md += "\n## Notes\n\n"
    md += "- This is a **raw spaCy NER** baseline without Presidio's wrapper.\n"
    md += "- spaCy detects: PERSON, ORG, GPE/LOC, DATE, TIME, CARDINAL, etc.\n"
    md += "- It does **NOT** detect: SSN, Credit Card, IBAN, API Key, Email, Phone, IP Address\n"
    md += "- Use this baseline to understand NER contribution vs regex contribution.\n"
    md += "- Model: en_core_web_lg (or en_core_web_sm fallback)\n"

    report_path = os.path.join(output_dir, "SPACY_BASELINE.md")
    os.makedirs(output_dir, exist_ok=True)
    with open(report_path, "w") as f:
        f.write(md)
    print(f"Report saved → {report_path}")
    return report_path


def main() -> None:
    parser = argparse.ArgumentParser(description="spaCy NER Baseline Evaluation")
    parser.add_argument("--data", type=str, default=None, help="Path to dataset JSON")
    parser.add_argument("--suite", choices=["presidio-research", "pii-bench", "tab"], default="presidio-research")
    parser.add_argument("--model", type=str, default="en_core_web_lg", help="spaCy model name")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output-dir", type=str, default="benchmarks/spacy/results")
    args = parser.parse_args()

    set_seeds(args.seed)
    nlp = load_spacy_model(args.model)

    # Load dataset
    if args.data:
        with open(args.data) as f:
            samples = json.load(f)
    elif args.suite == "presidio-research":
        data_path = "benchmarks/data/synthetic_llm_prompts.json"
        if not os.path.exists(data_path):
            print(f"[ERROR] Dataset not found at {data_path}. Generate with: python -m benchmarks.run --generate-only")
            sys.exit(1)
        with open(data_path) as f:
            samples = json.load(f)
    elif args.suite == "pii-bench":
        from benchmarks.pii_bench.downloader import download_pii_bench, load_pii_bench, normalize_pii_bench_sample
        download_pii_bench()
        raw = load_pii_bench()
        samples = [normalize_pii_bench_sample(r) for r in raw]
    elif args.suite == "tab":
        from benchmarks.tab.downloader import download_tab, load_tab, normalize_tab_document
        download_tab()
        raw = load_tab()
        samples = [normalize_tab_document(r) for r in raw]
    else:
        print("[ERROR] No dataset specified and no suite selected.")
        sys.exit(1)

    print(f"\nDataset: {len(samples)} samples")

    # Run evaluation
    metrics = run_spacy_evaluation(samples, nlp)
    agg = compute_aggregate(metrics)

    print(f"\nspaCy NER Baseline:")
    print(f"  F₂ = {agg.f2:.4f}  Recall = {agg.recall:.4f}  Precision = {agg.precision:.4f}")

    # Save results
    json_path = save_results_json(metrics, agg, args.output_dir)
    print(f"\nResults saved → {json_path}")

    # Save latest symlink
    latest_path = os.path.join(args.output_dir, "latest.json")
    with open(latest_path, "w") as f:
        json.dump({
            "system": "spaCy NER",
            "model": args.model,
            "aggregate": agg.to_dict(),
            "per_entity": {k: v.to_dict() for k, v in metrics.items()},
        }, f, indent=2)

    # Generate report
    generate_spacy_report(metrics, agg, args.output_dir)


if __name__ == "__main__":
    main()
