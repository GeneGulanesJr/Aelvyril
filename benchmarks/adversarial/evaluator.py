"""
Adversarial Robustness Benchmark for Aelvyril PII Detection.

Evaluates detection resilience against adversarial perturbations:
    - Character-level attacks (leet speak, homoglyphs, zero-width chars)
    - Word-level attacks (obfuscation, synonym replacement)
    - Contextual attacks (code blocks, HTML wrapping)
    - Composite attacks (multiple perturbations combined)

Outputs per-attack-type degradation metrics showing how much each attack
reduces F2 score relative to the clean baseline.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from benchmarks.adversarial.perturbations import AttackRegistry
from benchmarks.common.metrics import EntityMetrics, SpanMatch, evaluate_entity_types, compute_aggregate
from benchmarks.common.reporting import format_results_as_markdown, save_results_json
from benchmarks.data_generators.llm_prompt_templates import LLMPromptDataGenerator


@dataclass
class RobustnessResult:
    """Degradation metrics for a single attack type."""
    attack_name: str
    clean_f2: float
    attacked_f2: float
    absolute_degradation: float
    relative_degradation: float  # percentage
    clean_recall: float
    attacked_recall: float
    recall_degradation: float

    def to_dict(self) -> Dict:
        return {
            "attack": self.attack_name,
            "clean_f2": round(self.clean_f2, 4),
            "attacked_f2": round(self.attacked_f2, 4),
            "absolute_degradation": round(self.absolute_degradation, 4),
            "relative_degradation": round(self.relative_degradation, 4),
            "clean_recall": round(self.clean_recall, 4),
            "attacked_recall": round(self.attacked_recall, 4),
            "recall_degradation": round(self.recall_degradation, 4),
        }


class AelvyrilClient:
    """HTTP client for Aelvyril /analyze endpoint."""

    def __init__(self, service_url: str = "http://localhost:3000/analyze"):
        self.service_url = service_url

    def detect(self, text: str) -> List[SpanMatch]:
        try:
            resp = requests.post(
                self.service_url,
                json={"text": text, "language": "en"},
                timeout=10,
            )
            resp.raise_for_status()
            data = resp.json()
            results = data.get("result", data) if isinstance(data, dict) else data
            spans = []
            for m in results:
                spans.append(SpanMatch(
                    entity_type=m.get("entity_type", "UNKNOWN"),
                    start=m.get("start", 0),
                    end=m.get("end", 0),
                    text=m.get("text", ""),
                    score=m.get("score", 0.0),
                ))
            return spans
        except Exception as e:
            print(f"[WARN] Detection failed: {e}")
            return []


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
        [SpanMatch(entity_type=e["entity_type"], start=e["start"], end=e["end"], text=e.get("text", ""))
         for e in s.spans]
        for s in samples
    ]
    return texts, gold


def evaluate_robustness(
    client: AelvyrilClient,
    texts: List[str],
    gold_spans: List[List[SpanMatch]],
    attacks: List[str],
    iou_threshold: float = 0.5,
    seed: int = 42,
) -> Tuple[EntityMetrics, Dict[str, RobustnessResult]]:
    """Evaluate clean baseline and per-attack degradation."""

    # Clean baseline
    print("[INFO] Running clean baseline...")
    clean_preds: List[List[SpanMatch]] = []
    for idx, text in enumerate(texts):
        clean_preds.append(client.detect(text))
        if (idx + 1) % 100 == 0:
            print(f"  Clean: {idx + 1}/{len(texts)}")

    clean_per_entity = evaluate_entity_types(
        [s for sample in clean_preds for s in sample],
        [s for sample in gold_spans for s in sample],
        iou_threshold,
    )
    clean_aggregate = compute_aggregate(clean_per_entity, average="micro")
    print(f"[BASELINE] Clean F2: {clean_aggregate.f2:.4f}, Recall: {clean_aggregate.recall:.4f}")

    results: Dict[str, RobustnessResult] = {}

    for attack_name in attacks:
        print(f"[INFO] Testing attack: {attack_name}...")
        attacked_preds: List[List[SpanMatch]] = []

        for idx, text in enumerate(texts):
            attacked_text = AttackRegistry.apply(text, attack_name, seed=seed + idx)
            attacked_preds.append(client.detect(attacked_text))
            if (idx + 1) % 100 == 0:
                print(f"  {attack_name}: {idx + 1}/{len(texts)}")

        attacked_per_entity = evaluate_entity_types(
            [s for sample in attacked_preds for s in sample],
            [s for sample in gold_spans for s in sample],
            iou_threshold,
        )
        attacked_aggregate = compute_aggregate(attacked_per_entity, average="micro")

        abs_deg = clean_aggregate.f2 - attacked_aggregate.f2
        rel_deg = (abs_deg / clean_aggregate.f2 * 100) if clean_aggregate.f2 > 0 else 0.0
        rec_deg = clean_aggregate.recall - attacked_aggregate.recall

        results[attack_name] = RobustnessResult(
            attack_name=attack_name,
            clean_f2=clean_aggregate.f2,
            attacked_f2=attacked_aggregate.f2,
            absolute_degradation=abs_deg,
            relative_degradation=rel_deg,
            clean_recall=clean_aggregate.recall,
            attacked_recall=attacked_aggregate.recall,
            recall_degradation=rec_deg,
        )

        print(f"  [{attack_name}] F2: {attacked_aggregate.f2:.4f} "
              f"(degradation: {rel_deg:.1f}%)")

    return clean_aggregate, results


def generate_robustness_report(
    clean_aggregate: EntityMetrics,
    results: Dict[str, RobustnessResult],
    output_dir: str,
) -> str:
    """Generate ADVERSARIAL_ROBUSTNESS.md report."""
    lines = [
        "# Adversarial Robustness Report",
        "",
        f"**Clean Baseline F2:** {clean_aggregate.f2:.4f}",
        f"**Clean Baseline Recall:** {clean_aggregate.recall:.4f}",
        f"**Clean Baseline Precision:** {clean_aggregate.precision:.4f}",
        "",
        "## Attack Degradation Summary",
        "",
        "| Attack | Attacked F2 | Abs Degradation | Rel Degradation | Recall Drop |",
        "|--------|-------------|-----------------|-----------------|-------------|",
    ]

    sorted_results = sorted(results.values(), key=lambda r: r.relative_degradation, reverse=True)
    for r in sorted_results:
        lines.append(
            f"| {r.attack_name} | {r.attacked_f2:.4f} | {r.absolute_degradation:.4f} "
            f"| {r.relative_degradation:.1f}% | {r.recall_degradation:.4f} |"
        )

    lines.extend([
        "",
        "## Interpretation",
        "",
        "- **Relative Degradation > 20%**: Critical vulnerability. Detection collapses under this attack.",
        "- **Relative Degradation 10-20%**: Moderate vulnerability. Consider hardening.",
        "- **Relative Degradation < 10%**: Resilient. Attack has minimal impact.",
        "",
        "### Hardening Recommendations",
        "",
    ])

    critical = [r for r in sorted_results if r.relative_degradation > 20]
    moderate = [r for r in sorted_results if 10 <= r.relative_degradation <= 20]

    if critical:
        lines.append("#### Critical Vulnerabilities")
        for r in critical:
            lines.append(f"- **{r.attack_name}**: {r.relative_degradation:.1f}% degradation. "
                        f"Prioritize countermeasures (e.g., normalization pipeline, explicit detection rules).")
        lines.append("")

    if moderate:
        lines.append("#### Moderate Vulnerabilities")
        for r in moderate:
            lines.append(f"- **{r.attack_name}**: {r.relative_degradation:.1f}% degradation. "
                        "Consider detection improvements or input sanitization.")
        lines.append("")

    if not critical and not moderate:
        lines.append("All attacks show <10% degradation. The system is robust against the tested adversarial perturbations.")
        lines.append("")

    report_path = os.path.join(output_dir, "ADVERSARIAL_ROBUSTNESS.md")
    os.makedirs(output_dir, exist_ok=True)
    with open(report_path, "w") as f:
        f.write("\n".join(lines))
    return report_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Adversarial Robustness Benchmark")
    parser.add_argument("--num-samples", type=int, default=500)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--data", type=str, default=None)
    parser.add_argument("--service-url", type=str, default="http://localhost:3000/analyze")
    parser.add_argument("--attacks", type=str, default=None,
                        help="Comma-separated attack names (default: all)")
    parser.add_argument("--output-dir", type=str, default="benchmarks/adversarial/results")
    parser.add_argument("--iou-threshold", type=float, default=0.5)
    args = parser.parse_args()

    print("=" * 60)
    print("Phase 3: Adversarial Robustness Benchmark")
    print("=" * 60)

    attacks = args.attacks.split(",") if args.attacks else AttackRegistry.list_attacks()
    print(f"[INFO] Attacks: {', '.join(attacks)}")

    client = AelvyrilClient(service_url=args.service_url)
    texts, gold = _load_or_generate_samples(args.num_samples, args.seed, args.data)
    print(f"[INFO] Evaluating on {len(texts)} samples...")

    start = time.time()
    clean_agg, results = evaluate_robustness(
        client, texts, gold, attacks, args.iou_threshold, args.seed
    )
    elapsed = time.time() - start

    print(f"[OK] Evaluation complete in {elapsed:.1f}s")

    # Save report
    report_path = generate_robustness_report(clean_agg, results, args.output_dir)
    print(f"[OK] Robustness report saved -> {report_path}")

    # Save JSON
    os.makedirs(args.output_dir, exist_ok=True)
    json_path = os.path.join(args.output_dir, "robustness_results.json")
    with open(json_path, "w") as f:
        json.dump({
            "clean_baseline": clean_agg.to_dict(),
            "attacks": {k: v.to_dict() for k, v in results.items()},
            "elapsed_seconds": elapsed,
            "num_samples": len(texts),
            "iou_threshold": args.iou_threshold,
        }, f, indent=2)
    print(f"[OK] JSON results saved -> {json_path}")


if __name__ == "__main__":
    main()
