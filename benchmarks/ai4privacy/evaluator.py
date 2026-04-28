"""
ai4privacy.eu PII Detection Benchmark Integration.

Evaluates the ai4privacy.eu API (https://www.ai4privacy.eu) as a comparative
baseline for PII detection. ai4privacy is a privacy-focused NLP service that
detects and anonymizes PII in text using fine-tuned transformer models.

This module wraps their REST API and evaluates it on the same datasets used
for Aelvyril benchmarking, enabling cross-system comparison.

API Documentation: https://docs.ai4privacy.eu
Free tier: 100 requests/day (sufficient for small benchmarks)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from benchmarks.common.metrics import EntityMetrics, SpanMatch, evaluate_entity_types, compute_aggregate
from benchmarks.common.reporting import format_results_as_markdown, save_results_json
from benchmarks.common.statistics import bootstrap_ci
from benchmarks.data_generators.llm_prompt_templates import LLMPromptDataGenerator


@dataclass
class AI4PrivacySpan:
    """Normalized span from ai4privacy API response."""
    entity_type: str
    start: int
    end: int
    text: str
    score: float = 1.0


# ai4privacy entity type -> benchmark canonical namespace.
#
# Design principles (matching NEMOTRON_ENTITY_MAP):
#   1. One-to-one: each ai4privacy type maps to exactly one canonical type.
#   2. No collapsing: CITY stays CITY, STREET_ADDRESS stays STREET_ADDRESS.
#   3. Fine-grained NER types kept distinct — they match Presidio's output.
#   4. Unknown types kept as-is so scoring shows "unrecognized" transparently.

AI4P_TO_CANONICAL: Dict[str, str] = {
    # Core PII
    "EMAIL": "EMAIL_ADDRESS",
    "PHONE": "PHONE_NUMBER",
    "PHONE_NUMBER": "PHONE_NUMBER",
    "CREDIT_CARD": "CREDIT_CARD",
    "SSN": "US_SSN",
    "IP_ADDRESS": "IP_ADDRESS",
    "IBAN": "IBAN_CODE",
    "API_KEY": "API_KEY",
    "CRYPTO": "API_KEY",
    "US_ZIP_CODE": "US_ZIP_CODE",
    "ZIP_CODE": "US_ZIP_CODE",
    "URL": "URL",
    # NER types (fine-grained, no collapsing)
    "PERSON": "PERSON",
    "PER": "PERSON",
    "LOCATION": "LOCATION",
    "CITY": "CITY",
    "US_STATE": "US_STATE",
    "STREET_ADDRESS": "STREET_ADDRESS",
    "COUNTRY": "COUNTRY",
    "ORGANIZATION": "ORGANIZATION",
    "ORG": "ORGANIZATION",
    "NRP": "ORGANIZATION",
    # Financial / government identifiers
    "SWIFT_CODE": "SWIFT_CODE",
    "SWIFT_BIC": "SWIFT_CODE",
    "US_BANK_NUMBER": "US_BANK_NUMBER",
    "BANK_ACCOUNT": "US_BANK_NUMBER",
    "US_PASSPORT": "US_PASSPORT",
    "PASSPORT": "US_PASSPORT",
    "US_DRIVER_LICENSE": "US_DRIVER_LICENSE",
    "DRIVER_LICENSE": "US_DRIVER_LICENSE",
    "NATIONAL_ID": "US_SSN",
    "TAX_ID": "US_SSN",
    # Other / demographics
    "DATE": "DATE_TIME",
    "DATETIME": "DATE_TIME",
    "AGE": "AGE",
    "TITLE": "TITLE",
    "NATIONALITY": "NATIONALITY",
    "MEDICAL_RECORD": "MEDICAL_RECORD",
    "MEDICAL_LICENSE": "MEDICAL_RECORD",
}


class AI4PrivacyEvaluator:
    """Wrapper for ai4privacy.eu API."""

    DEFAULT_URL = "https://api.ai4privacy.eu/v1/detect"
    MAX_RETRIES = 3
    RETRY_BACKOFF = [1, 2, 4]

    def __init__(self, api_key: Optional[str] = None, api_url: Optional[str] = None):
        self.api_url = api_url or self.DEFAULT_URL
        self.api_key = api_key
        self._failure_count = 0
        self._total_calls = 0

    def detect(self, text: str) -> List[AI4PrivacySpan]:
        """Send text to ai4privacy API and return detected PII spans."""
        self._total_calls += 1
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        payload = {"text": text, "language": "en"}

        for attempt, delay in enumerate(self.RETRY_BACKOFF):
            try:
                resp = requests.post(
                    self.api_url,
                    json=payload,
                    headers=headers,
                    timeout=15,
                )
                if resp.status_code == 429:
                    print(f"[WARN] ai4privacy rate limit hit. Waiting {delay}s...")
                    time.sleep(delay * 2)
                    continue
                resp.raise_for_status()
                data = resp.json()

                spans: List[AI4PrivacySpan] = []
                for entity in data.get("entities", data.get("results", [])):
                    raw_type = entity.get("type", entity.get("label", "UNKNOWN"))
                    canonical = AI4P_TO_CANONICAL.get(raw_type.upper(), raw_type.upper())
                    spans.append(AI4PrivacySpan(
                        entity_type=canonical,
                        start=entity.get("start", 0),
                        end=entity.get("end", 0),
                        text=entity.get("text", ""),
                        score=entity.get("confidence", entity.get("score", 1.0)),
                    ))
                return spans

            except requests.RequestException as e:
                if attempt < self.MAX_RETRIES - 1:
                    time.sleep(delay)
                    continue
                self._failure_count += 1
                print(f"[WARN] ai4privacy request failed: {e}")
                return []

        return []

    @property
    def failure_rate(self) -> float:
        return self._failure_count / max(self._total_calls, 1)

    def is_healthy(self) -> bool:
        return self.failure_rate < 0.05


def _load_or_generate_samples(
    num_samples: int,
    seed: int,
    data_path: Optional[str] = None,
) -> Tuple[List[str], List[List[SpanMatch]]]:
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


def evaluate_ai4privacy(
    evaluator: AI4PrivacyEvaluator,
    texts: List[str],
    gold_spans: List[List[SpanMatch]],
    iou_threshold: float = 0.5,
) -> Tuple[Dict[str, EntityMetrics], EntityMetrics, List[List[SpanMatch]]]:
    """Evaluate ai4privacy on a dataset."""
    predicted_samples: List[List[SpanMatch]] = []

    for idx, text in enumerate(texts):
        spans = evaluator.detect(text)
        predicted = [
            SpanMatch(entity_type=s.entity_type, start=s.start, end=s.end, text=s.text, score=s.score)
            for s in spans
        ]
        predicted_samples.append(predicted)

        if (idx + 1) % 50 == 0:
            print(f"  Processed {idx + 1}/{len(texts)} samples...")
            # Rate limit protection: sleep briefly every 50 requests
            time.sleep(0.5)

    per_entity = evaluate_entity_types(
        [s for sample in predicted_samples for s in sample],
        [s for sample in gold_spans for s in sample],
        iou_threshold,
    )
    aggregate = compute_aggregate(per_entity, average="micro")
    return per_entity, aggregate, predicted_samples


def main() -> None:
    parser = argparse.ArgumentParser(description="ai4privacy PII Detection Benchmark")
    parser.add_argument("--num-samples", type=int, default=500)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--data", type=str, default=None)
    parser.add_argument("--api-key", type=str, default=None, help="ai4privacy API key (optional)")
    parser.add_argument("--api-url", type=str, default=None)
    parser.add_argument("--output-dir", type=str, default="benchmarks/ai4privacy/results")
    parser.add_argument("--iou-threshold", type=float, default=0.5)
    args = parser.parse_args()

    print("=" * 60)
    print("Phase 3: ai4privacy PII Detection Benchmark")
    print("=" * 60)

    evaluator = AI4PrivacyEvaluator(api_key=args.api_key, api_url=args.api_url)

    # Quick health check
    print("[INFO] Testing ai4privacy API connectivity...")
    test_spans = evaluator.detect("Contact me at test@example.com or call 555-123-4567.")
    if evaluator.failure_rate > 0:
        print("[WARN] ai4privacy API health check failed. Skipping evaluation.")
        print("[HINT] Set --api-key if using authenticated tier, or check network.")
        return
    print(f"[OK] API responsive. Test detection found {len(test_spans)} spans.")

    texts, gold = _load_or_generate_samples(args.num_samples, args.seed, args.data)
    print(f"[INFO] Evaluating on {len(texts)} samples...")

    start = time.time()
    per_entity, aggregate, predicted_samples = evaluate_ai4privacy(
        evaluator, texts, gold, args.iou_threshold
    )
    elapsed = time.time() - start

    print(f"[OK] Evaluation complete in {elapsed:.1f}s")
    print(f"[RESULT] ai4privacy F2 Score: {aggregate.f2:.4f}")
    print(f"[RESULT] ai4privacy Recall:   {aggregate.recall:.4f}")
    print(f"[RESULT] ai4privacy Precision: {aggregate.precision:.4f}")
    print(f"[RESULT] Failure rate: {evaluator.failure_rate:.1%}")

    # Bootstrap CI
    print("[INFO] Computing bootstrap confidence intervals...")
    sample_f2_scores: List[float] = []
    for pred, gold_sample in zip(predicted_samples, gold):
        pe = evaluate_entity_types(pred, gold_sample, args.iou_threshold)
        agg = compute_aggregate(pe, average="micro")
        sample_f2_scores.append(agg.f2)

    bootstrap = bootstrap_ci(sample_f2_scores, num_iterations=10000, seed=args.seed)
    print(f"[RESULT] 95% CI for F2: [{bootstrap.ci_lower:.4f}, {bootstrap.ci_upper:.4f}]")

    # Save
    os.makedirs(args.output_dir, exist_ok=True)
    md = format_results_as_markdown(per_entity, aggregate, title="ai4privacy PII Detection Results")
    md_path = os.path.join(args.output_dir, "results.md")
    with open(md_path, "w") as f:
        f.write(md)
    print(f"[OK] Markdown report saved -> {md_path}")

    json_path = save_results_json(per_entity, aggregate, args.output_dir, extra_meta={
        "benchmark": "ai4privacy",
        "num_samples": len(texts),
        "iou_threshold": args.iou_threshold,
        "elapsed_seconds": elapsed,
        "failure_rate": evaluator.failure_rate,
        "bootstrap": bootstrap.to_dict(),
    })
    print(f"[OK] JSON results saved -> {json_path}")


if __name__ == "__main__":
    main()
