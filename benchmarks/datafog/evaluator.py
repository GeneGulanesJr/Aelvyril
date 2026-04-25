"""
DataFog PII Detection Benchmark Integration.

Evaluates the open-source DataFog library (https://github.com/datafog/datafog)
as a comparative baseline for PII detection. DataFog uses a hybrid approach
combining regex, NER (spaCy), and transformer-based models.

This module wraps DataFog's detection API and evaluates it on the same
synthetic and real datasets used for Aelvyril benchmarking, enabling
apples-to-apples comparison.

Requirements:
    pip install datafog

If datafog is not installed, the evaluator gracefully degrades and reports
"unavailable" status.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from benchmarks.common.metrics import EntityMetrics, SpanMatch, evaluate_entity_types, match_spans, compute_aggregate
from benchmarks.common.reporting import format_results_as_markdown, save_results_json
from benchmarks.common.statistics import bootstrap_ci
from benchmarks.data_generators.llm_prompt_templates import LLMPromptDataGenerator


@dataclass
class DataFogSpan:
    """Normalized span representation from DataFog output."""
    entity_type: str
    start: int
    end: int
    text: str
    score: float = 1.0


# Map DataFog entity types to Aelvyril canonical types
DATAFOG_TO_CANONICAL: Dict[str, str] = {
    "EMAIL": "EMAIL_ADDRESS",
    "PHONE_NUMBER": "PHONE_NUMBER",
    "CREDIT_CARD": "CREDIT_CARD",
    "SSN": "US_SSN",
    "IP_ADDRESS": "IP_ADDRESS",
    "IBAN": "IBAN_CODE",
    "PERSON": "PERSON",
    "LOCATION": "LOCATION",
    "ORGANIZATION": "ORGANIZATION",
    "DATE": "DATE_TIME",
    "URL": "DOMAIN_NAME",
    "DOMAIN": "DOMAIN_NAME",
    "API_KEY": "API_KEY",
    "CRYPTO": "API_KEY",
    "US_ZIP_CODE": "US_ZIP_CODE",
    "ZIP_CODE": "US_ZIP_CODE",
    "ADDRESS": "LOCATION",
    "STREET_ADDRESS": "LOCATION",
    "CITY": "LOCATION",
    "STATE": "LOCATION",
    "COUNTRY": "LOCATION",
    "NRP": "ORGANIZATION",
    "MEDICAL_LICENSE": "API_KEY",
}


def _check_datafog_available() -> bool:
    try:
        import datafog  # noqa: F401
        return True
    except ImportError:
        return False


def _normalize_datafog_type(raw_type: str) -> str:
    """Map DataFog raw entity type to canonical benchmark type."""
    upper = raw_type.upper().replace(" ", "_")
    return DATAFOG_TO_CANONICAL.get(upper, upper)


def run_datafog_detection(text: str) -> List[DataFogSpan]:
    """Run DataFog PII detection on a single text sample.

    Returns empty list if DataFog is not installed or fails.
    """
    if not _check_datafog_available():
        return []

    try:
        from datafog import DataFog
        df = DataFog()
        results = df.run(text)
        spans: List[DataFogSpan] = []
        for r in results:
            spans.append(DataFogSpan(
                entity_type=_normalize_datafog_type(r.get("label", "UNKNOWN")),
                start=r.get("start", 0),
                end=r.get("end", 0),
                text=r.get("text", ""),
                score=r.get("score", 1.0),
            ))
        return spans
    except Exception as e:
        print(f"[WARN] DataFog detection failed: {e}")
        return []


def _load_or_generate_samples(
    num_samples: int,
    seed: int,
    data_path: Optional[str] = None,
) -> Tuple[List[str], List[List[SpanMatch]]]:
    """Load existing dataset or generate synthetic samples."""
    if data_path and os.path.exists(data_path):
        with open(data_path) as f:
            data = json.load(f)
        texts = [s["text"] for s in data]
        gold = [
            [SpanMatch(entity_type=e["type"], start=e["start"], end=e["end"], text=e.get("text", ""))
             for e in s.get("entities", [])]
            for s in data
        ]
        return texts, gold

    print(f"[INFO] Generating {num_samples} synthetic samples (seed={seed})...")
    gen = LLMPromptDataGenerator(seed=seed)
    samples = gen.generate_dataset(num_samples=num_samples)
    texts = [s.text for s in samples]
    gold = [
        [SpanMatch(entity_type=e["entity_type"], start=e["start"], end=e["end"], text=e["text"])
         for e in s.spans]
        for s in samples
    ]
    return texts, gold


def evaluate_datafog(
    texts: List[str],
    gold_spans: List[List[SpanMatch]],
    iou_threshold: float = 0.5,
) -> Tuple[Dict[str, EntityMetrics], EntityMetrics]:
    """Evaluate DataFog on a dataset and return per-entity and aggregate metrics."""
    predicted_samples: List[List[SpanMatch]] = []

    for idx, text in enumerate(texts):
        df_spans = run_datafog_detection(text)
        predicted = [
            SpanMatch(entity_type=s.entity_type, start=s.start, end=s.end, text=s.text, score=s.score)
            for s in df_spans
        ]
        predicted_samples.append(predicted)

        if (idx + 1) % 100 == 0:
            print(f"  Processed {idx + 1}/{len(texts)} samples...")

    per_entity = evaluate_entity_types(
        [s for sample in predicted_samples for s in sample],
        [s for sample in gold_spans for s in sample],
        iou_threshold,
    )
    aggregate = compute_aggregate(per_entity, average="micro")
    return per_entity, aggregate


def main() -> None:
    parser = argparse.ArgumentParser(description="DataFog PII Detection Benchmark")
    parser.add_argument("--num-samples", type=int, default=1000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--data", type=str, default=None, help="Path to existing dataset JSON")
    parser.add_argument("--output-dir", type=str, default="benchmarks/datafog/results")
    parser.add_argument("--iou-threshold", type=float, default=0.5)
    args = parser.parse_args()

    print("=" * 60)
    print("Phase 3: DataFog PII Detection Benchmark")
    print("=" * 60)

    if not _check_datafog_available():
        print("[SKIP] DataFog not installed. Install with: pip install datafog")
        print("[SKIP] Skipping DataFog evaluation.")
        sys.exit(0)

    print(f"[OK] DataFog detected.")

    texts, gold = _load_or_generate_samples(args.num_samples, args.seed, args.data)
    print(f"[INFO] Evaluating on {len(texts)} samples...")

    start = time.time()
    per_entity, aggregate = evaluate_datafog(texts, gold, args.iou_threshold)
    elapsed = time.time() - start

    print(f"[OK] Evaluation complete in {elapsed:.1f}s")
    print(f"[RESULT] DataFog F2 Score: {aggregate.f2:.4f}")
    print(f"[RESULT] DataFog Recall:   {aggregate.recall:.4f}")
    print(f"[RESULT] DataFog Precision: {aggregate.precision:.4f}")

    # Bootstrap CI on per-sample F2 scores
    print("[INFO] Computing bootstrap confidence intervals...")
    sample_f2_scores: List[float] = []
    for pred, gold_sample in zip(predicted_samples_global, gold):
        pe = evaluate_entity_types([pred], [gold_sample], args.iou_threshold)
        agg = compute_aggregate(pe, average="micro")
        sample_f2_scores.append(agg.f2)

    bootstrap = bootstrap_ci(sample_f2_scores, num_iterations=10000, seed=args.seed)
    print(f"[RESULT] 95% CI for F2: [{bootstrap.ci_lower:.4f}, {bootstrap.ci_upper:.4f}]")

    # Save results
    os.makedirs(args.output_dir, exist_ok=True)
    md = format_results_as_markdown(per_entity, aggregate, title="DataFog PII Detection Results")
    md_path = os.path.join(args.output_dir, "results.md")
    with open(md_path, "w") as f:
        f.write(md)
    print(f"[OK] Markdown report saved -> {md_path}")

    json_path = save_results_json(per_entity, aggregate, args.output_dir, extra_meta={
        "benchmark": "datafog",
        "num_samples": len(texts),
        "iou_threshold": args.iou_threshold,
        "elapsed_seconds": elapsed,
        "bootstrap": bootstrap.to_dict(),
    })
    print(f"[OK] JSON results saved -> {json_path}")


# Global for bootstrap access
predicted_samples_global: List[List[SpanMatch]] = []


if __name__ == "__main__":
    main()
