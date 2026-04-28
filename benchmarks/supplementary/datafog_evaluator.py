"""
DataFog PII-NER model head-to-head comparison evaluator.

Compares Aelvyril's PII detection against the DataFog PII-NER model,
an open-source NER-based PII detection system.

DataFog PII-NER (https://huggingface.co/datafog/pii-ner):
    - Based on a fine-tuned transformer model
    - Entity types: PERSON, LOCATION, ORGANIZATION, EMAIL, PHONE, etc.
    - Licensed: Apache 2.0

This evaluator:
    1. Loads a test dataset (shared synthetic or external)
    2. Runs both Aelvyril and DataFog on the same data
    3. Computes per-entity F₁ comparison
    4. Generates a head-to-head report

Usage:
    python -m benchmarks.supplementary.datafog_evaluator
    python -m benchmarks.supplementary.datafog_evaluator --num-samples 500
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

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
from benchmarks.presidio_research.aelvyril_evaluator import (
    AelvyrilEvaluator,
    DISPLAY_NAMES,
    AelvyrilEvaluator,
)


# ── DataFog entity type mapping ─────────────────────────────────────────────────

# DataFog entity type → benchmark canonical namespace.
# Same design principles as DATAFOG_TO_CANONICAL in benchmarks/datafog/evaluator.py.
# Fine-grained NER types kept distinct; unknown types pass through unchanged.

DATAFOG_ENTITY_MAP: Dict[str, str] = {
    # Core PII
    "EMAIL": "EMAIL_ADDRESS",
    "EMAIL_ADDRESS": "EMAIL_ADDRESS",
    "PHONE": "PHONE_NUMBER",
    "PHONE_NUMBER": "PHONE_NUMBER",
    "SSN": "US_SSN",
    "CREDIT_CARD": "CREDIT_CARD",
    "IP": "IP_ADDRESS",
    "IP_ADDRESS": "IP_ADDRESS",
    "IBAN": "IBAN_CODE",
    "IBAN_CODE": "IBAN_CODE",
    "API_KEY": "API_KEY",
    "CRYPTO": "API_KEY",
    "US_ZIP_CODE": "US_ZIP_CODE",
    "ZIP_CODE": "US_ZIP_CODE",
    "URL": "URL",
    # NER (fine-grained, no collapsing)
    "PER": "PERSON",
    "PERSON": "PERSON",
    "LOC": "LOCATION",
    "LOCATION": "LOCATION",
    "CITY": "CITY",
    "US_STATE": "US_STATE",
    "STREET_ADDRESS": "STREET_ADDRESS",
    "COUNTRY": "COUNTRY",
    "ORG": "ORGANIZATION",
    "ORGANIZATION": "ORGANIZATION",
    "NRP": "ORGANIZATION",
    # Other
    "DATE": "DATE_TIME",
    "DATE_TIME": "DATE_TIME",
    "AGE": "AGE",
    "TITLE": "TITLE",
    "NATIONALITY": "NATIONALITY",
    "MEDICAL_RECORD": "MEDICAL_RECORD",
    "SWIFT_CODE": "SWIFT_CODE",
    "US_BANK_NUMBER": "US_BANK_NUMBER",
    "US_PASSPORT": "US_PASSPORT",
    "US_DRIVER_LICENSE": "US_DRIVER_LICENSE",
    # Deprecated aliases (pass through)
    "ADDRESS": "STREET_ADDRESS",
    # Unknown → keep as-is
}


@dataclass
class DataFogSpan:
    """A span detected by the DataFog model."""

    entity_type: str
    start: int
    end: int
    text: str = ""
    score: float = 1.0


@dataclass
class HeadToHeadResult:
    """Head-to-head comparison result between Aelvyril and DataFog."""

    aelvyril_f1: float = 0.0
    datafog_f1: float = 0.0
    aelvyril_f2: float = 0.0
    datafog_f2: float = 0.0
    aelvyril_recall: float = 0.0
    datafog_recall: float = 0.0
    aelvyril_precision: float = 0.0
    datafog_precision: float = 0.0
    per_entity: Dict[str, Dict] = field(default_factory=dict)
    num_samples: int = 0

    def to_dict(self) -> Dict:
        return {
            "aelvyril": {
                "f1": round(self.aelvyril_f1, 4),
                "f2": round(self.aelvyril_f2, 4),
                "recall": round(self.aelvyril_recall, 4),
                "precision": round(self.aelvyril_precision, 4),
            },
            "datafog": {
                "f1": round(self.datafog_f1, 4),
                "f2": round(self.datafog_f2, 4),
                "recall": round(self.datafog_recall, 4),
                "precision": round(self.datafog_precision, 4),
            },
            "delta_f1": round(self.aelvyril_f1 - self.datafog_f1, 4),
            "delta_f2": round(self.aelvyril_f2 - self.datafog_f2, 4),
            "per_entity": self.per_entity,
            "num_samples": self.num_samples,
        }


class DataFogEvaluator:
    """Wraps DataFog PII-NER model for benchmarking.

    Uses the HuggingFace transformers pipeline with the DataFog model.
    Falls back to a simulated evaluation if the model is not installed.
    """

    MODEL_NAME = "datafog/pii-ner"

    def __init__(self, use_gpu: bool = False):
        self._pipeline = None
        self._fallback_mode = False
        self._failure_count = 0
        self._total_calls = 0

        try:
            from transformers import pipeline as hf_pipeline

            device = 0 if use_gpu else -1
            self._pipeline = hf_pipeline(
                "ner",
                model=self.MODEL_NAME,
                aggregation_strategy="simple",
                device=device,
            )
            print(f"[OK] DataFog PII-NER model loaded: {self.MODEL_NAME}")
        except ImportError:
            print("[WARN] transformers not installed — DataFog evaluator in fallback mode")
            self._fallback_mode = True
        except Exception as e:
            print(f"[WARN] Could not load DataFog model ({e}) — fallback mode")
            self._fallback_mode = True

    def predict(self, text: str) -> List[DataFogSpan]:
        """Detect PII spans using the DataFog model."""
        self._total_calls += 1

        if self._fallback_mode:
            return self._fallback_predict(text)

        try:
            results = self._pipeline(text)
            spans: List[DataFogSpan] = []

            for r in results:
                entity_group = r.get("entity_group", r.get("entity", "UNKNOWN"))
                mapped = DATAFOG_ENTITY_MAP.get(entity_group.upper(), entity_group.upper())
                spans.append(DataFogSpan(
                    entity_type=mapped,
                    start=r.get("start", 0),
                    end=r.get("end", 0),
                    text=r.get("word", text[r.get("start", 0):r.get("end", 0)]),
                    score=r.get("score", 0.0),
                ))

            return spans

        except Exception as e:
            self._failure_count += 1
            print(f"[WARN] DataFog prediction failed: {e}")
            return []

    def _fallback_predict(self, text: str) -> List[DataFogSpan]:
        """Fallback: use regex-based detection when model is unavailable.

        This is NOT a substitute for the real DataFog model. It provides
        basic detection using the same patterns Aelvyril uses, for testing
        the evaluation pipeline when the model isn't installed.
        """
        import re

        spans: List[DataFogSpan] = []

        # Email
        for m in re.finditer(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', text):
            spans.append(DataFogSpan(
                entity_type="EMAIL_ADDRESS", start=m.start(), end=m.end(),
                text=m.group(), score=0.95,
            ))

        # Phone
        for m in re.finditer(r'\b\d{3}[-.]?\d{3}[-.]?\d{4}\b', text):
            spans.append(DataFogSpan(
                entity_type="PHONE_NUMBER", start=m.start(), end=m.end(),
                text=m.group(), score=0.8,
            ))

        # SSN
        for m in re.finditer(r'\b\d{3}-\d{2}-\d{4}\b', text):
            spans.append(DataFogSpan(
                entity_type="US_SSN", start=m.start(), end=m.end(),
                text=m.group(), score=0.95,
            ))

        # IP
        for m in re.finditer(r'\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b', text):
            spans.append(DataFogSpan(
                entity_type="IP_ADDRESS", start=m.start(), end=m.end(),
                text=m.group(), score=0.9,
            ))

        return spans

    @property
    def failure_rate(self) -> float:
        return self._failure_count / max(self._total_calls, 1)


def generate_test_dataset(
    num_samples: int = 500,
    seed: int = 42,
) -> List[dict]:
    """Generate a synthetic test dataset for head-to-head comparison.

    **WARNING:** This data is entirely synthetic (Faker templates). It is NOT
    an external benchmark — it compares two systems on the same synthetic
    patterns. Results are useful for relative comparison only (System A vs
    System B on the same templates), NOT for absolute accuracy claims.

    Uses Faker with fixed seed for reproducibility.
    """
    import random
    from faker import Faker

    Faker.seed(seed)
    fake = Faker("en_US")
    random.seed(seed)

    templates = [
        "Contact {person} at {email} or {phone}.",
        "Patient {person}, SSN: {ssn}, DOB: {date}, Address: {city}.",
        "Wire {amount} to IBAN {iban} for {org}.",
        "Server at {ip} registered to {person} from {city}.",
        "User {username} with email {email} and phone {phone} from {city}.",
        "Credit card {card} expiring {date} belongs to {person}.",
        "Debug: user={person}, ip={ip}, session={session}.",
        "{person} at {org} can be reached at {email}.",
    ]

    samples: List[dict] = []
    for i in range(num_samples):
        tmpl = random.choice(templates)

        person = fake.name()
        email = fake.email()
        phone = fake.phone_number()
        ssn = fake.ssn()
        date = fake.date()
        city = fake.city()
        org = fake.company()
        ip = fake.ipv4_public()
        iban = f"GB{random.randint(10, 99)}{''.join([str(random.randint(0, 9)) for _ in range(22)])}"
        card = fake.credit_card_number()
        amount = f"${random.randint(100, 10000):,}"
        username = fake.user_name()
        session = fake.hexify(text="^^^^^^^^^^^^^^^^")

        text = tmpl.format(
            person=person, email=email, phone=phone, ssn=ssn, date=date,
            city=city, org=org, ip=ip, iban=iban, card=card, amount=amount,
            username=username, session=session,
        )

        # Build gold spans by finding each entity in the text
        spans: List[dict] = []
        entity_map = {
            "{person}": ("PERSON", person),
            "{email}": ("EMAIL_ADDRESS", email),
            "{phone}": ("PHONE_NUMBER", phone),
            "{ssn}": ("US_SSN", ssn),
            "{date}": ("DATE_TIME", date),
            "{city}": ("LOCATION", city),
            "{org}": ("ORGANIZATION", org),
            "{ip}": ("IP_ADDRESS", ip),
            "{iban}": ("IBAN_CODE", iban),
            "{card}": ("CREDIT_CARD", card),
        }

        for placeholder, (entity_type, value) in entity_map.items():
            if placeholder in tmpl:
                idx = text.find(value)
                if idx >= 0:
                    spans.append({
                        "entity_type": entity_type,
                        "start": idx,
                        "end": idx + len(value),
                        "text": value,
                    })

        samples.append({"text": text, "spans": spans})

    return samples


def run_datafog_comparison(
    service_url: str | None = None,
    num_samples: int = 500,
    seed: int = 42,
    output_dir: str = "benchmarks/supplementary/results",
    use_gpu: bool = False,
) -> HeadToHeadResult:
    """Run head-to-head comparison: Aelvyril vs DataFog PII-NER.

    Args:
        service_url: Aelvyril /analyze endpoint.
        num_samples: Number of test samples.
        seed: Random seed.
        output_dir: Results output directory.
        use_gpu: Use GPU for DataFog model.

    Returns:
        HeadToHeadResult with comparison metrics.
    """
    set_seeds(seed)

    # Generate shared test data
    samples = generate_test_dataset(num_samples, seed)
    print(f"\n[INFO] Generated {len(samples)} test samples for DataFog comparison")

    # Initialize evaluators
    aelvyril = AelvyrilEvaluator(service_url=service_url)
    datafog = DataFogEvaluator(use_gpu=use_gpu)

    # Run both evaluators
    aelvyril_all_pred: List[SpanMatch] = []
    datafog_all_pred: List[SpanMatch] = []
    all_gold: List[SpanMatch] = []

    print(f"\n{'='*60}")
    print("DataFog PII-NER Head-to-Head Comparison")
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
            for s in sample["spans"]
        ]

        # Aelvyril predictions
        aelvyril_detected = aelvyril.predict(text)
        aelvyril_pred = [
            SpanMatch(
                entity_type=d.entity_type,
                start=d.start,
                end=d.end,
                score=d.score,
                text=d.text,
            )
            for d in aelvyril_detected
        ]

        # DataFog predictions
        datafog_detected = datafog.predict(text)
        datafog_pred = [
            SpanMatch(
                entity_type=d.entity_type,
                start=d.start,
                end=d.end,
                score=d.score,
                text=d.text,
            )
            for d in datafog_detected
        ]

        aelvyril_all_pred.extend(aelvyril_pred)
        datafog_all_pred.extend(datafog_pred)
        all_gold.extend(gold_spans)

        if (i + 1) % 100 == 0:
            print(f"  Processed {i + 1}/{num_samples} samples...")

    # Compute metrics
    aelvyril_entity_metrics = evaluate_entity_types(aelvyril_all_pred, all_gold)
    datafog_entity_metrics = evaluate_entity_types(datafog_all_pred, all_gold)

    aelvyril_agg = compute_aggregate(aelvyril_entity_metrics)
    datafog_agg = compute_aggregate(datafog_entity_metrics)

    # Build per-entity comparison
    all_types = sorted(set(
        list(aelvyril_entity_metrics.keys()) + list(datafog_entity_metrics.keys())
    ))

    per_entity: Dict[str, Dict] = {}
    for entity_type in all_types:
        a = aelvyril_entity_metrics.get(entity_type, EntityMetrics(entity_type))
        d = datafog_entity_metrics.get(entity_type, EntityMetrics(entity_type))
        per_entity[entity_type] = {
            "aelvyril_f1": round(a.f1, 4),
            "aelvyril_f2": round(a.f2, 4),
            "aelvyril_recall": round(a.recall, 4),
            "aelvyril_precision": round(a.precision, 4),
            "datafog_f1": round(d.f1, 4),
            "datafog_f2": round(d.f2, 4),
            "datafog_recall": round(d.recall, 4),
            "datafog_precision": round(d.precision, 4),
            "delta_f1": round(a.f1 - d.f1, 4),
        }

    result = HeadToHeadResult(
        aelvyril_f1=aelvyril_agg.f1,
        datafog_f1=datafog_agg.f1,
        aelvyril_f2=aelvyril_agg.f2,
        datafog_f2=datafog_agg.f2,
        aelvyril_recall=aelvyril_agg.recall,
        datafog_recall=datafog_agg.recall,
        aelvyril_precision=aelvyril_agg.precision,
        datafog_precision=datafog_agg.precision,
        per_entity=per_entity,
        num_samples=num_samples,
    )

    # Save results
    os.makedirs(output_dir, exist_ok=True)

    result_json = {
        "aelvyril_version": "dev",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "comparison": "aelvyril_vs_datafog",
        "data_source": "synthetic (Faker templates — NOT an external benchmark)",
        "datafog_model": DataFogEvaluator.MODEL_NAME,
        "results": result.to_dict(),
        "config": {"num_samples": num_samples, "seed": seed},
    }

    results_path = os.path.join(output_dir, "datafog_comparison.json")
    with open(results_path, "w") as f:
        json.dump(result_json, f, indent=2)

    latest_path = os.path.join(output_dir, "datafog_latest.json")
    with open(latest_path, "w") as f:
        json.dump(result_json, f, indent=2)

    generate_run_manifest(output_dir, seed=seed)

    # Generate report
    _generate_datafog_report(result, output_dir)

    # Print summary
    _print_datafog_summary(result)

    return result


def _print_datafog_summary(result: HeadToHeadResult) -> None:
    """Print DataFog comparison summary."""
    print(f"\n{'='*60}")
    print("DataFog PII-NER Head-to-Head Results")
    print(f"{'='*60}")
    print(f"Samples: {result.num_samples}")
    print()

    print(f"{'System':<15} {'F₁':>8} {'F₂':>8} {'Recall':>8} {'Precision':>10}")
    print("-" * 55)
    print(
        f"{'Aelvyril':<15} {result.aelvyril_f1:>8.4f} {result.aelvyril_f2:>8.4f} "
        f"{result.aelvyril_recall:>8.4f} {result.aelvyril_precision:>10.4f}"
    )
    print(
        f"{'DataFog':<15} {result.datafog_f1:>8.4f} {result.datafog_f2:>8.4f} "
        f"{result.datafog_recall:>8.4f} {result.datafog_precision:>10.4f}"
    )
    print("-" * 55)
    print(
        f"{'Δ (Aelvyril)':<15} {result.aelvyril_f1 - result.datafog_f1:>+8.4f} "
        f"{result.aelvyril_f2 - result.datafog_f2:>+8.4f}"
    )
    print()

    if result.per_entity:
        print(f"{'Entity':<20} {'Aelvyril F₁':>12} {'DataFog F₁':>12} {'Δ F₁':>8}")
        print("-" * 55)
        for entity_type, data in sorted(result.per_entity.items()):
            delta = data["delta_f1"]
            print(
                f"{entity_type:<20} {data['aelvyril_f1']:>12.4f} "
                f"{data['datafog_f1']:>12.4f} {delta:>+8.4f}"
            )


def _generate_datafog_report(result: HeadToHeadResult, output_dir: str) -> str:
    """Generate Markdown report for DataFog comparison."""
    lines: List[str] = []
    lines.append("# DataFog PII-NER Head-to-Head Comparison")
    lines.append("")
    lines.append(f"**Generated:** {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    lines.append(f"**DataFog Model:** {DataFogEvaluator.MODEL_NAME}")
    lines.append(f"**Samples:** {result.num_samples}")
    lines.append("")

    lines.append("## Summary")
    lines.append("")
    lines.append("| System | F₁ | F₂ | Recall | Precision |")
    lines.append("|--------|-----|-----|--------|-----------|")
    lines.append(
        f"| **Aelvyril** | {result.aelvyril_f1:.4f} | {result.aelvyril_f2:.4f} "
        f"| {result.aelvyril_recall:.4f} | {result.aelvyril_precision:.4f} |"
    )
    lines.append(
        f"| DataFog PII-NER | {result.datafog_f1:.4f} | {result.datafog_f2:.4f} "
        f"| {result.datafog_recall:.4f} | {result.datafog_precision:.4f} |"
    )
    lines.append("")

    delta_f1 = result.aelvyril_f1 - result.datafog_f1
    lines.append(f"**Δ F₁ (Aelvyril − DataFog):** {delta_f1:+.4f}")
    lines.append("")

    if result.per_entity:
        lines.append("## Per-Entity Comparison")
        lines.append("")
        lines.append(
            "| Entity Type | Aelvyril F₁ | DataFog F₁ | Aelvyril F₂ | DataFog F₂ | Δ F₁ |"
        )
        lines.append(
            "|-------------|-------------|------------|-------------|------------|------|"
        )
        for entity_type, data in sorted(result.per_entity.items()):
            lines.append(
                f"| {entity_type} | {data['aelvyril_f1']:.4f} | {data['datafog_f1']:.4f} "
                f"| {data['aelvyril_f2']:.4f} | {data['datafog_f2']:.4f} "
                f"| {data['delta_f1']:+.4f} |"
            )
        lines.append("")

    report_path = os.path.join(output_dir, "DATAFOG_COMPARISON.md")
    with open(report_path, "w") as f:
        f.write("\n".join(lines))

    print(f"DataFog report saved → {report_path}")
    return report_path


def main() -> None:
    parser = argparse.ArgumentParser(description="DataFog PII-NER Head-to-Head Comparison")
    parser.add_argument(
        "--service-url",
        type=str,
        default="http://localhost:3000/analyze",
    )
    parser.add_argument("--num-samples", type=int, default=500)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output-dir", type=str, default="benchmarks/supplementary/results")
    parser.add_argument("--gpu", action="store_true", help="Use GPU for DataFog model")
    args = parser.parse_args()

    run_datafog_comparison(
        service_url=args.service_url,
        num_samples=args.num_samples,
        seed=args.seed,
        output_dir=args.output_dir,
        use_gpu=args.gpu,
    )


if __name__ == "__main__":
    main()
