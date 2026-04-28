"""
ai4privacy/open-pii-masking-500k evaluator — large-scale validation subset.

Evaluates Aelvyril on a subset of the ai4privacy dataset:
    - 500,000+ synthetic samples across 50+ languages
    - Covers 20+ PII entity types
    - Licensed: Apache 2.0
    - Source: https://huggingface.co/datasets/ai4privacy/open-pii-masking-500k

This evaluator:
    1. Downloads a configurable subset (default: 2,000 English samples)
    2. Runs Aelvyril detection on each sample
    3. Computes per-entity F₂ scores
    4. Generates a large-scale validation report

Usage:
    python -m benchmarks.supplementary.ai4privacy_evaluator
    python -m benchmarks.supplementary.ai4privacy_evaluator --num-samples 2000
    python -m benchmarks.supplementary.ai4privacy_evaluator --language en
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from benchmarks.common.metrics import (
    EntityMetrics,
    SpanMatch,
    evaluate_entity_types,
    compute_aggregate,
)
from benchmarks.common.reporting import (
    generate_run_manifest,
    save_results_json,
)
from benchmarks.common.utils import set_seeds
from benchmarks.presidio_research.aelvyril_evaluator import (
    AelvyrilEvaluator,
    DISPLAY_NAMES,
    AelvyrilEvaluator,
)


# ── ai4privacy entity type mapping ──────────────────────────────────────────────

AI4PRIVACY_ENTITY_MAP: Dict[str, str] = {
    # ── Names ─────────────────────────────────────────────────────────────
    "FIRSTNAME": "PERSON",
    "LASTNAME": "PERSON",
    "MIDDLENAME": "PERSON",
    "NAME": "PERSON",
    "PER": "PERSON",
    # ── Contact ───────────────────────────────────────────────────────────
    "EMAIL": "EMAIL_ADDRESS",
    "EMAILADDRESS": "EMAIL_ADDRESS",
    "PHONENUMBER": "PHONE_NUMBER",
    "TELEPHONENUMBER": "PHONE_NUMBER",
    "TELEPHONENUM": "PHONE_NUMBER",
    "MOBILEPHONENUMBER": "PHONE_NUMBER",
    # ── Government / ID numbers ───────────────────────────────────────────
    "SOCIALNUM": "US_SSN",
    "SSN": "US_SSN",
    "NATIONALID": "US_SSN",
    "PASSPORTNUM": "US_PASSPORT",
    "DRIVERLICENSENUM": "US_DRIVER_LICENSE",
    "TAXNUM": "US_SSN",
    # ── Financial ─────────────────────────────────────────────────────────
    "CREDITCARDNUMBER": "CREDIT_CARD",
    "CREDITCARD": "CREDIT_CARD",
    "IBAN": "IBAN_CODE",
    "BANKACCOUNTNUM": "US_BANK_NUMBER",
    "SWIFTCODE": "SWIFT_CODE",
    # ── Location (fine-grained, no collapsing) ───────────────────────────
    "CITY": "CITY",
    "US_STATE": "US_STATE",
    "STATE": "US_STATE",
    "STREET_ADDRESS": "STREET_ADDRESS",
    "STREET": "STREET_ADDRESS",
    "ADDRESS": "STREET_ADDRESS",
    "COUNTY": "LOCATION",
    "COUNTRY": "COUNTRY",
    "ZIPCODE": "US_ZIP_CODE",
    "POSTALCODE": "US_ZIP_CODE",
    # ── Digital / credentials ──────────────────────────────────────────────
    "IPADDRESS": "IP_ADDRESS",
    "IP": "IP_ADDRESS",
    "URL": "URL",
    "DOMAIN": "URL",
    "USERNAME": "PERSON",
    "PASSWORD": "API_KEY",       # credentials → API_KEY, not "API_Key"
    "APIKEY": "API_KEY",         # must match uppercase benchmark namespace
    # ── Time / demographics ───────────────────────────────────────────────
    "DATEOFBIRTH": "DATE_TIME",
    "DATE": "DATE_TIME",
    "TIME": "DATE_TIME",
    "DATETIME": "DATE_TIME",
    "AGE": "AGE",               # not DATE_TIME — AGE is a distinct type
    "OCCUPATION": "TITLE",      # job title ≠ organization
    "JOBTITLE": "TITLE",
    "GENDER": "NRP",
    "NATIONALITY": "NATIONALITY", # not LOCATION — nationality ≠ location
    # ── Organizations ────────────────────────────────────────────────────
    "COMPANYNAME": "ORGANIZATION",
    "COMPANY": "ORGANIZATION",
    "ORGANIZATION": "ORGANIZATION",
    "ORG": "ORGANIZATION",
    "NRP": "ORGANIZATION",
}


@dataclass
class AI4PrivacyResult:
    """Results from ai4privacy evaluation."""

    f2_score: float = 0.0
    f1_score: float = 0.0
    recall: float = 0.0
    precision: float = 0.0
    num_samples: int = 0
    per_entity: Dict[str, Dict] = field(default_factory=dict)

    def to_dict(self) -> Dict:
        return {
            "f2_score": round(self.f2_score, 4),
            "f1_score": round(self.f1_score, 4),
            "recall": round(self.recall, 4),
            "precision": round(self.precision, 4),
            "num_samples": self.num_samples,
            "per_entity": self.per_entity,
        }


def load_ai4privacy_subset(
    num_samples: int = 2000,
    language: str = "en",
    seed: int = 42,
    data_dir: str = "benchmarks/data/ai4privacy",
) -> List[dict]:
    """Load a subset of the ai4privacy dataset.

    Attempts to load from HuggingFace datasets. Falls back to generating
    synthetic data in the same format if the dataset is not available.

    Args:
        num_samples: Number of samples to load.
        language: Language code (default: "en").
        seed: Random seed for sampling.
        data_dir: Directory to cache downloaded data.

    Returns:
        List of samples in unified format.
    """
    import random

    random.seed(seed)
    os.makedirs(data_dir, exist_ok=True)

    cache_path = os.path.join(data_dir, f"subset_{language}_{num_samples}.json")

    # Check cache
    if os.path.exists(cache_path):
        print(f"[OK] Loading cached ai4privacy subset from {cache_path}")
        with open(cache_path) as f:
            return json.load(f)

    # Try loading from HuggingFace
    try:
        from datasets import load_dataset

        print(f"[INFO] Loading ai4privacy/open-pii-masking-500k from HuggingFace...")
        ds = load_dataset(
            "ai4privacy/open-pii-masking-500k",
            split="train",
            streaming=True,
        )

        # Filter by language and collect samples
        samples: List[dict] = []
        for row in ds:
            # Check language
            row_lang = row.get("language", "en")
            if row_lang != language:
                continue

            text = row.get("source_text", row.get("text", ""))
            if not text:
                continue

            # Extract spans from masked text / annotations
            spans: List[dict] = []
            raw_spans = row.get("privacy_masked_spans", row.get("spans", []))

            if isinstance(raw_spans, list):
                for span in raw_spans:
                    if isinstance(span, dict):
                        entity_type = span.get("entity_type", span.get("label", "UNKNOWN"))
                        mapped = AI4PRIVACY_ENTITY_MAP.get(
                            entity_type.upper(), entity_type.upper()
                        )
                        spans.append({
                            "entity_type": mapped,
                            "start": span.get("start", span.get("start_offset", 0)),
                            "end": span.get("end", span.get("end_offset", 0)),
                            "text": span.get("value", span.get("text", "")),
                        })

            samples.append({"text": text, "spans": spans})

            if len(samples) >= num_samples:
                break

        if samples:
            # Cache the subset
            with open(cache_path, "w") as f:
                json.dump(samples, f, indent=2)
            print(f"[OK] Loaded {len(samples)} ai4privacy samples (cached to {cache_path})")
            return samples

    except ImportError:
        pass  # Will be caught by the empty-samples check below
    except Exception as e:
        print(f"[WARN] Could not load ai4privacy dataset: {e}")

    # No synthetic fallback — if we don't have real data, fail explicitly
    if not samples:
        raise RuntimeError(
            "ai4privacy dataset is not available. Install the HuggingFace datasets "
            "library and ensure access, or provide data manually.\n"
            "  pip install datasets\n"
            "  huggingface-cli login\n"
            "Or place data files in the cache directory."
        )
    return samples


def run_ai4privacy_evaluation(
    service_url: str | None = None,
    num_samples: int = 2000,
    language: str = "en",
    seed: int = 42,
    output_dir: str = "benchmarks/supplementary/results",
) -> AI4PrivacyResult:
    """Run ai4privacy large-scale validation.

    Args:
        service_url: Aelvyril /analyze endpoint.
        num_samples: Number of samples to evaluate.
        language: Language code.
        seed: Random seed.
        output_dir: Results directory.

    Returns:
        AI4PrivacyResult with evaluation metrics.
    """
    set_seeds(seed)

    # Load dataset
    samples = load_ai4privacy_subset(num_samples, language, seed)
    print(f"\n[INFO] Loaded {len(samples)} ai4privacy samples for evaluation")

    # Initialize evaluator
    evaluator = AelvyrilEvaluator(service_url=service_url)

    # Run evaluation
    all_predicted: List[SpanMatch] = []
    all_gold: List[SpanMatch] = []

    print(f"\n{'='*60}")
    print("ai4privacy Large-Scale Validation")
    print(f"{'='*60}")

    for i, sample in enumerate(samples):
        text = sample["text"]
        gold_spans = [
            SpanMatch(
                entity_type=s["entity_type"],
                start=s["start"],
                end=s["end"],
                text=s.get("text", ""),
            )
            for s in sample.get("spans", [])
        ]

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

    print(f"  Processed {len(samples)}/{len(samples)} samples.")

    # Compute metrics
    entity_metrics = evaluate_entity_types(all_predicted, all_gold)
    aggregate = compute_aggregate(entity_metrics)

    per_entity = {
        entity_type: {
            "f2": round(m.f2, 4),
            "f1": round(m.f1, 4),
            "recall": round(m.recall, 4),
            "precision": round(m.precision, 4),
            "tp": m.true_positives,
            "fp": m.false_positives,
            "fn": m.false_negatives,
        }
        for entity_type, m in entity_metrics.items()
    }

    result = AI4PrivacyResult(
        f2_score=aggregate.f2,
        f1_score=aggregate.f1,
        recall=aggregate.recall,
        precision=aggregate.precision,
        num_samples=len(samples),
        per_entity=per_entity,
    )

    # Save
    os.makedirs(output_dir, exist_ok=True)

    result_json = {
        "aelvyril_version": "dev",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "benchmark": "ai4privacy/open-pii-masking-500k",
        "results": result.to_dict(),
        "config": {
            "num_samples": num_samples,
            "language": language,
            "seed": seed,
        },
    }

    results_path = os.path.join(output_dir, "ai4privacy_results.json")
    with open(results_path, "w") as f:
        json.dump(result_json, f, indent=2)

    latest_path = os.path.join(output_dir, "ai4privacy_latest.json")
    with open(latest_path, "w") as f:
        json.dump(result_json, f, indent=2)

    generate_run_manifest(output_dir, seed=seed)

    # Generate report
    _generate_ai4privacy_report(result, output_dir)

    # Print summary
    _print_ai4privacy_summary(result)

    return result


def _print_ai4privacy_summary(result: AI4PrivacyResult) -> None:
    """Print ai4privacy evaluation summary."""
    print(f"\n{'='*60}")
    print("ai4privacy Large-Scale Validation Results")
    print(f"{'='*60}")
    print(f"Samples: {result.num_samples}")
    print()
    print(f"  F₂:          {result.f2_score:.4f}")
    print(f"  F₁:          {result.f1_score:.4f}")
    print(f"  Recall:      {result.recall:.4f}")
    print(f"  Precision:   {result.precision:.4f}")
    print()

    if result.per_entity:
        print(f"{'Entity':<20} {'F₂':>8} {'F₁':>8} {'Recall':>8} {'Prec':>8} {'TP':>5} {'FP':>5} {'FN':>5}")
        print("-" * 75)
        for entity_type, data in sorted(result.per_entity.items()):
            print(
                f"{entity_type:<20} {data['f2']:>8.4f} {data['f1']:>8.4f} "
                f"{data['recall']:>8.4f} {data['precision']:>8.4f} "
                f"{data['tp']:>5} {data['fp']:>5} {data['fn']:>5}"
            )


def _generate_ai4privacy_report(result: AI4PrivacyResult, output_dir: str) -> str:
    """Generate Markdown report for ai4privacy evaluation."""
    lines: List[str] = []
    lines.append("# ai4privacy Large-Scale Validation Report")
    lines.append("")
    lines.append(f"**Generated:** {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    lines.append(f"**Dataset:** ai4privacy/open-pii-masking-500k (Apache 2.0)")
    lines.append(f"**Samples:** {result.num_samples}")
    lines.append("")

    lines.append("## Summary")
    lines.append("")
    lines.append("| Metric | Value |")
    lines.append("|--------|-------|")
    lines.append(f"| **F₂ (β=2)** | {result.f2_score:.4f} |")
    lines.append(f"| **F₁** | {result.f1_score:.4f} |")
    lines.append(f"| **Recall** | {result.recall:.4f} |")
    lines.append(f"| **Precision** | {result.precision:.4f} |")
    lines.append("")

    if result.per_entity:
        lines.append("## Per-Entity Breakdown")
        lines.append("")
        lines.append("| Entity Type | F₂ | F₁ | Recall | Precision | TP | FP | FN |")
        lines.append("|-------------|-----|-----|--------|-----------|-----|-----|-----|")
        for entity_type, data in sorted(result.per_entity.items()):
            lines.append(
                f"| {entity_type} | {data['f2']:.4f} | {data['f1']:.4f} "
                f"| {data['recall']:.4f} | {data['precision']:.4f} "
                f"| {data['tp']} | {data['fp']} | {data['fn']} |"
            )
        lines.append("")

    report_path = os.path.join(output_dir, "AI4PRIVACY_REPORT.md")
    with open(report_path, "w") as f:
        f.write("\n".join(lines))

    print(f"ai4privacy report saved → {report_path}")
    return report_path


def main() -> None:
    parser = argparse.ArgumentParser(description="ai4privacy Large-Scale Validation")
    parser.add_argument("--service-url", type=str, default="http://localhost:3000/analyze")
    parser.add_argument("--num-samples", type=int, default=2000)
    parser.add_argument("--language", type=str, default="en")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output-dir", type=str, default="benchmarks/supplementary/results")
    args = parser.parse_args()

    run_ai4privacy_evaluation(
        service_url=args.service_url,
        num_samples=args.num_samples,
        language=args.language,
        seed=args.seed,
        output_dir=args.output_dir,
    )


if __name__ == "__main__":
    main()
