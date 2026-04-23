"""
TAB (Text Anonymization Benchmark) evaluator.

Evaluates anonymization quality by measuring re-identification risk,
not just entity detection. Goes beyond detection to assess whether
masking decisions correctly protect against re-identification.

Key Metrics:
    - R_direct: Recall of DIRECT identifiers that were correctly masked
    - R_quasi: Recall of QUASI identifiers that were correctly masked
    - Precision: Fraction of masked spans that actually needed masking
    - Weighted F1: Combined metric weighting DIRECT more than QUASI

TAB Entity Types:
    PERSON, ORG, LOC, DATETIME, CODE, DEM (demographic)

Masking Decisions (identifier_type):
    DIRECT  → Must mask (name, SSN, direct identifier)
    QUASI   → Should mask (date, location, quasi-identifier)
    NO_MASK → Should NOT mask (public information)

Paper: https://arxiv.org/abs/2202.00443
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from benchmarks.common.reporting import generate_run_manifest
from benchmarks.common.utils import set_seeds
from benchmarks.presidio_research.aelvyril_evaluator import (
    AelvyrilEvaluator,
    PRESIDIO_TO_AELVYRIL,
)
from benchmarks.tab.downloader import (
    download_tab,
    load_tab,
    normalize_tab_document,
    TAB_ENTITY_MAP,
)


# ── Data Classes ────────────────────────────────────────────────────────────────


@dataclass
class TabSpan:
    """A text span with masking decision metadata."""

    entity_type: str
    start: int
    end: int
    text: str = ""
    identifier_type: str = "NO_MASK"  # DIRECT | QUASI | NO_MASK
    needs_masking: bool = False
    score: float = 1.0


@dataclass
class TabMetrics:
    """TAB anonymization quality metrics."""

    # Overall masking quality
    precision: float = 0.0
    recall_direct: float = 0.0
    recall_quasi: float = 0.0
    f1_direct: float = 0.0
    f1_quasi: float = 0.0

    # Weighted F1 (DIRECT weighted 2×, QUASI weighted 1×)
    weighted_f1: float = 0.0

    # Detection quality (ignoring masking decisions)
    detection_precision: float = 0.0
    detection_recall: float = 0.0
    detection_f1: float = 0.0

    # Counts
    num_documents: int = 0
    total_gold_direct: int = 0
    total_gold_quasi: int = 0
    total_gold_no_mask: int = 0
    total_predicted: int = 0

    # Per-entity breakdown
    per_entity: Dict[str, dict] = field(default_factory=dict)

    def to_dict(self) -> Dict:
        return {
            "precision": round(self.precision, 4),
            "recall_direct": round(self.recall_direct, 4),
            "recall_quasi": round(self.recall_quasi, 4),
            "f1_direct": round(self.f1_direct, 4),
            "f1_quasi": round(self.f1_quasi, 4),
            "weighted_f1": round(self.weighted_f1, 4),
            "detection_precision": round(self.detection_precision, 4),
            "detection_recall": round(self.detection_recall, 4),
            "detection_f1": round(self.detection_f1, 4),
            "num_documents": self.num_documents,
            "counts": {
                "gold_direct": self.total_gold_direct,
                "gold_quasi": self.total_gold_quasi,
                "gold_no_mask": self.total_gold_no_mask,
                "predicted": self.total_predicted,
            },
            "per_entity": self.per_entity,
        }


# ── Matching Logic ──────────────────────────────────────────────────────────────


def _match_spans_by_overlap(
    predicted: List[TabSpan],
    gold: List[TabSpan],
    iou_threshold: float = 0.5,
) -> Tuple[int, int, int, Dict[str, dict]]:
    """Match predicted spans against gold spans using IoU overlap.

    For TAB evaluation, matching considers both entity type AND
    the masking decision. A predicted span "correctly masks" a gold span
    if the entity types match AND the gold span needs masking (DIRECT/QUASI).

    Args:
        predicted: List of predicted (detected) spans.
        gold: List of ground-truth spans with masking decisions.
        iou_threshold: Minimum IoU for a match.

    Returns:
        (true_positives, false_positives, false_negatives, per_entity_metrics)
    """
    matched_gold: Set[int] = set()
    tp = 0

    # Sort predictions by score descending
    sorted_pred = sorted(predicted, key=lambda s: s.score, reverse=True)

    for pred in sorted_pred:
        best_iou = 0.0
        best_gi = -1

        for gi, g in enumerate(gold):
            if gi in matched_gold:
                continue
            # Match on entity type (allow mapped types)
            if not _types_compatible(pred.entity_type, g.entity_type):
                continue

            # Compute IoU
            intersection_start = max(pred.start, g.start)
            intersection_end = min(pred.end, g.end)
            intersection = max(0, intersection_end - intersection_start)

            union_start = min(pred.start, g.start)
            union_end = max(pred.end, g.end)
            union = union_end - union_start

            iou = intersection / union if union > 0 else 0.0

            if iou > best_iou:
                best_iou = iou
                best_gi = gi

        if best_iou >= iou_threshold and best_gi >= 0:
            tp += 1
            matched_gold.add(best_gi)

    fp = len(predicted) - tp
    fn = len(gold) - tp

    return tp, fp, fn


def _types_compatible(pred_type: str, gold_type: str) -> bool:
    """Check if predicted and gold entity types are compatible."""
    if pred_type == gold_type:
        return True

    # Allow some type mapping flexibility
    compatible_groups = [
        {"PERSON", "Person"},
        {"LOCATION", "Location", "LOC"},
        {"ORGANIZATION", "Organization", "ORG"},
        {"DATE_TIME", "Date", "DATETIME"},
        {"CODE"},
    ]

    for group in compatible_groups:
        if pred_type in group and gold_type in group:
            return True

    return False


def compute_tab_metrics(
    predicted: List[TabSpan],
    gold: List[TabSpan],
    iou_threshold: float = 0.5,
) -> TabMetrics:
    """Compute TAB anonymization quality metrics.

    Separates gold spans by masking decision (DIRECT/QUASI/NO_MASK)
    and computes per-category recall.
    """
    gold_direct = [s for s in gold if s.identifier_type == "DIRECT"]
    gold_quasi = [s for s in gold if s.identifier_type == "QUASI"]
    gold_no_mask = [s for s in gold if s.identifier_type == "NO_MASK"]
    gold_needs_masking = [s for s in gold if s.needs_masking]

    # Detection metrics: all gold vs all predicted
    det_tp, det_fp, det_fn = _match_spans_by_overlap(predicted, gold, iou_threshold)
    det_prec = det_tp / (det_tp + det_fp) if (det_tp + det_fp) > 0 else 0.0
    det_rec = det_tp / (det_tp + det_fn) if (det_tp + det_fn) > 0 else 0.0
    det_f1 = 2 * det_prec * det_rec / (det_prec + det_rec) if (det_prec + det_rec) > 0 else 0.0

    # Masking quality: how many DIRECT/QUASI spans were caught
    dir_tp, dir_fp, dir_fn = _match_spans_by_overlap(predicted, gold_direct, iou_threshold)
    r_direct = dir_tp / len(gold_direct) if gold_direct else 1.0
    p_direct = dir_tp / (dir_tp + dir_fp) if (dir_tp + dir_fp) > 0 else 0.0
    f1_direct = 2 * p_direct * r_direct / (p_direct + r_direct) if (p_direct + r_direct) > 0 else 0.0

    qua_tp, qua_fp, qua_fn = _match_spans_by_overlap(predicted, gold_quasi, iou_threshold)
    r_quasi = qua_tp / len(gold_quasi) if gold_quasi else 1.0
    p_quasi = qua_tp / (qua_tp + qua_fp) if (qua_tp + qua_fp) > 0 else 0.0
    f1_quasi = 2 * p_quasi * r_quasi / (p_quasi + r_quasi) if (p_quasi + r_quasi) > 0 else 0.0

    # Overall precision: fraction of predictions that matched a masking-needed span
    mask_tp, mask_fp, mask_fn = _match_spans_by_overlap(predicted, gold_needs_masking, iou_threshold)
    precision = mask_tp / (mask_tp + mask_fp) if (mask_tp + mask_fp) > 0 else 0.0

    # Weighted F1: DIRECT weighted 2×, QUASI weighted 1×
    if f1_direct + f1_quasi > 0:
        weighted_f1 = (2 * f1_direct + f1_quasi) / 3
    else:
        weighted_f1 = 0.0

    # Per-entity breakdown
    entity_types = set(
        [s.entity_type for s in gold] + [s.entity_type for s in predicted]
    )
    per_entity: Dict[str, dict] = {}

    for entity_type in sorted(entity_types):
        pred_of_type = [s for s in predicted if s.entity_type == entity_type]
        gold_of_type = [s for s in gold if s.entity_type == entity_type]
        gold_dir = [s for s in gold_of_type if s.identifier_type == "DIRECT"]
        gold_qua = [s for s in gold_of_type if s.identifier_type == "QUASI"]

        etp, efp, efn = _match_spans_by_overlap(pred_of_type, gold_of_type, iou_threshold)
        e_prec = etp / (etp + efp) if (etp + efp) > 0 else 0.0
        e_rec = etp / (etp + efn) if (etp + efn) > 0 else 0.0
        e_f1 = 2 * e_prec * e_rec / (e_prec + e_rec) if (e_prec + e_rec) > 0 else 0.0

        dir_tp_e, _, dir_fn_e = _match_spans_by_overlap(pred_of_type, gold_dir, iou_threshold)
        qua_tp_e, _, qua_fn_e = _match_spans_by_overlap(pred_of_type, gold_qua, iou_threshold)

        per_entity[entity_type] = {
            "precision": round(e_prec, 4),
            "recall": round(e_rec, 4),
            "f1": round(e_f1, 4),
            "recall_direct": round(dir_tp_e / len(gold_dir), 4) if gold_dir else 1.0,
            "recall_quasi": round(qua_tp_e / len(gold_qua), 4) if gold_qua else 1.0,
            "gold_count": len(gold_of_type),
            "pred_count": len(pred_of_type),
            "direct_count": len(gold_dir),
            "quasi_count": len(gold_qua),
        }

    return TabMetrics(
        precision=precision,
        recall_direct=r_direct,
        recall_quasi=r_quasi,
        f1_direct=f1_direct,
        f1_quasi=f1_quasi,
        weighted_f1=weighted_f1,
        detection_precision=det_prec,
        detection_recall=det_rec,
        detection_f1=det_f1,
        num_documents=1,
        total_gold_direct=len(gold_direct),
        total_gold_quasi=len(gold_quasi),
        total_gold_no_mask=len(gold_no_mask),
        total_predicted=len(predicted),
        per_entity=per_entity,
    )


def aggregate_tab_metrics(metrics_list: List[TabMetrics]) -> TabMetrics:
    """Aggregate TAB metrics across multiple documents by summing counts
    and recomputing rates.
    """
    if not metrics_list:
        return TabMetrics()

    total_direct_tp = 0
    total_direct_gold = sum(m.total_gold_direct for m in metrics_list)
    total_quasi_tp = 0
    total_quasi_gold = sum(m.total_gold_quasi for m in metrics_list)
    total_predicted = sum(m.total_predicted for m in metrics_list)
    total_gold = sum(
        m.total_gold_direct + m.total_gold_quasi + m.total_gold_no_mask
        for m in metrics_list
    )

    # Approximate TP from recall
    total_direct_tp = round(total_direct_gold * sum(
        m.recall_direct * m.total_gold_direct for m in metrics_list
    ) / max(total_direct_gold, 1))

    total_quasi_tp = round(total_quasi_gold * sum(
        m.recall_quasi * m.total_gold_quasi for m in metrics_list
    ) / max(total_quasi_gold, 1))

    r_direct = total_direct_tp / total_direct_gold if total_direct_gold else 1.0
    r_quasi = total_quasi_tp / total_quasi_gold if total_quasi_gold else 1.0

    # Merge per-entity metrics
    merged_per_entity: Dict[str, dict] = defaultdict(lambda: {
        "gold_count": 0, "pred_count": 0,
        "direct_count": 0, "quasi_count": 0,
        "direct_tp": 0, "quasi_tp": 0, "tp": 0,
    })

    for m in metrics_list:
        for etype, data in m.per_entity.items():
            merged = merged_per_entity[etype]
            merged["gold_count"] += data.get("gold_count", 0)
            merged["pred_count"] += data.get("pred_count", 0)
            merged["direct_count"] += data.get("direct_count", 0)
            merged["quasi_count"] += data.get("quasi_count", 0)
            merged["direct_tp"] += round(
                data.get("recall_direct", 0) * data.get("direct_count", 0)
            )
            merged["quasi_tp"] += round(
                data.get("recall_quasi", 0) * data.get("quasi_count", 0)
            )
            merged["tp"] += round(
                data.get("recall", 0) * data.get("gold_count", 0)
            )

    per_entity: Dict[str, dict] = {}
    for etype, merged in merged_per_entity.items():
        tp = merged["tp"]
        gc = merged["gold_count"]
        pc = merged["pred_count"]
        prec = tp / pc if pc else 0.0
        rec = tp / gc if gc else 0.0
        f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0

        per_entity[etype] = {
            "precision": round(prec, 4),
            "recall": round(rec, 4),
            "f1": round(f1, 4),
            "recall_direct": round(merged["direct_tp"] / merged["direct_count"], 4) if merged["direct_count"] else 1.0,
            "recall_quasi": round(merged["quasi_tp"] / merged["quasi_count"], 4) if merged["quasi_count"] else 1.0,
            "gold_count": gc,
            "pred_count": pc,
            "direct_count": merged["direct_count"],
            "quasi_count": merged["quasi_count"],
        }

    return TabMetrics(
        recall_direct=r_direct,
        recall_quasi=r_quasi,
        num_documents=len(metrics_list),
        total_gold_direct=total_direct_gold,
        total_gold_quasi=total_quasi_gold,
        total_gold_no_mask=sum(m.total_gold_no_mask for m in metrics_list),
        total_predicted=total_predicted,
        per_entity=per_entity,
    )


# ── Evaluation Runner ───────────────────────────────────────────────────────────


def run_tab_evaluation(
    service_url: str = "http://localhost:3000/analyze",
    splits: Optional[List[str]] = None,
    max_documents: Optional[int] = None,
    iou_threshold: float = 0.5,
    seed: int = 42,
    output_dir: str = "benchmarks/tab/results",
    skip_download: bool = False,
) -> TabMetrics:
    """Run the full TAB evaluation against Aelvyril.

    Args:
        service_url: Aelvyril /analyze endpoint URL.
        splits: TAB splits to evaluate (default: test).
        max_documents: Cap on documents to evaluate.
        iou_threshold: IoU threshold for span matching.
        seed: Random seed for reproducibility.
        output_dir: Directory for results.
        skip_download: Skip download if data exists.

    Returns:
        TabMetrics with computed scores.
    """
    set_seeds(seed)
    splits = splits or ["test"]

    # Step 1: Load TAB corpus
    if not skip_download:
        download_tab(splits=splits)

    raw_docs = load_tab(splits=splits, max_documents=max_documents)
    print(f"\n[INFO] Loaded {len(raw_docs)} TAB documents")

    # Step 2: Initialize evaluator
    evaluator = AelvyrilEvaluator(service_url=service_url)

    # Step 3: Run evaluation
    all_metrics: List[TabMetrics] = []

    print(f"\n{'='*60}")
    print("Running TAB Anonymization Evaluation")
    print(f"{'='*60}")

    for i, raw_doc in enumerate(raw_docs):
        doc = normalize_tab_document(raw_doc)
        text = doc["text"]

        # Get Aelvyril predictions
        detected = evaluator.predict(text)

        # Convert to TabSpan objects
        pred_spans = [
            TabSpan(
                entity_type=PRESIDIO_TO_AELVYRIL.get(d.entity_type, d.entity_type),
                start=d.start,
                end=d.end,
                text=d.text,
                score=d.score,
            )
            for d in detected
        ]

        gold_spans = [
            TabSpan(
                entity_type=s["entity_type"],
                start=s["start"],
                end=s["end"],
                text=s.get("text", ""),
                identifier_type=s.get("identifier_type", "NO_MASK"),
                needs_masking=s.get("needs_masking", False),
            )
            for s in doc["spans"]
        ]

        doc_metrics = compute_tab_metrics(pred_spans, gold_spans, iou_threshold)
        all_metrics.append(doc_metrics)

        if (i + 1) % 100 == 0:
            print(f"  Processed {i + 1}/{len(raw_docs)} documents...")

    print(f"  Processed {len(raw_docs)}/{len(raw_docs)} documents.")

    # Step 4: Aggregate metrics
    aggregated = aggregate_tab_metrics(all_metrics)

    # Step 5: Health check
    if not evaluator.is_healthy():
        print(f"[ERROR] Evaluator failure rate: {evaluator.failure_rate:.2%}")

    # Step 6: Save results
    os.makedirs(output_dir, exist_ok=True)

    result = {
        "aelvyril_version": "dev",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tab_evaluation": aggregated.to_dict(),
        "config": {
            "iou_threshold": iou_threshold,
            "splits": splits,
            "seed": seed,
            "max_documents": max_documents,
        },
    }

    full_path = os.path.join(output_dir, "tab_results.json")
    with open(full_path, "w") as f:
        json.dump(result, f, indent=2)

    latest_path = os.path.join(output_dir, "latest.json")
    with open(latest_path, "w") as f:
        json.dump(result, f, indent=2)

    generate_run_manifest(output_dir, seed=seed)

    # Step 7: Print summary
    _print_tab_summary(aggregated)

    return aggregated


def _print_tab_summary(metrics: TabMetrics) -> None:
    """Print TAB evaluation summary."""
    print(f"\n{'='*60}")
    print("TAB Anonymization Evaluation Results")
    print(f"{'='*60}")
    print(f"Documents: {metrics.num_documents}")
    print()

    print("┌──────────────────────────────────────────────────────┐")
    print("│            Anonymization Quality Metrics             │")
    print("├──────────────────────────────────────────────────────┤")
    print(f"│  R_direct (recall of must-mask):  {metrics.recall_direct:.4f}            │")
    print(f"│  R_quasi (recall of should-mask): {metrics.recall_quasi:.4f}            │")
    print(f"│  F1_direct:                       {metrics.f1_direct:.4f}            │")
    print(f"│  F1_quasi:                        {metrics.f1_quasi:.4f}            │")
    print(f"│  Weighted F1:                     {metrics.weighted_f1:.4f}            │")
    print(f"│  Precision:                       {metrics.precision:.4f}            │")
    print("├──────────────────────────────────────────────────────┤")
    print("│            Detection Quality (agnostic to masking)   │")
    print("├──────────────────────────────────────────────────────┤")
    print(f"│  Detection Precision:             {metrics.detection_precision:.4f}            │")
    print(f"│  Detection Recall:                {metrics.detection_recall:.4f}            │")
    print(f"│  Detection F1:                    {metrics.detection_f1:.4f}            │")
    print("├──────────────────────────────────────────────────────┤")
    print("│            Counts                                   │")
    print("├──────────────────────────────────────────────────────┤")
    print(f"│  Gold DIRECT:  {metrics.total_gold_direct:>6}                              │")
    print(f"│  Gold QUASI:   {metrics.total_gold_quasi:>6}                              │")
    print(f"│  Gold NO_MASK: {metrics.total_gold_no_mask:>6}                              │")
    print(f"│  Predicted:    {metrics.total_predicted:>6}                              │")
    print("└──────────────────────────────────────────────────────┘")

    if metrics.per_entity:
        print()
        print("Per-Entity Breakdown:")
        print(
            f"{'Entity':<15} {'R_direct':>10} {'R_quasi':>10} {'F1':>8} "
            f"{'Direct':>8} {'Quasi':>8} {'Total':>8}"
        )
        print("-" * 70)
        for entity_type, data in sorted(metrics.per_entity.items()):
            print(
                f"{entity_type:<15} {data.get('recall_direct', 0):>10.4f} "
                f"{data.get('recall_quasi', 0):>10.4f} "
                f"{data.get('f1', 0):>8.4f} "
                f"{data.get('direct_count', 0):>8} "
                f"{data.get('quasi_count', 0):>8} "
                f"{data.get('gold_count', 0):>8}"
            )


def generate_tab_report(
    metrics: TabMetrics,
    output_dir: str,
) -> str:
    """Generate TAB_ANONYMIZATION_REPORT.md.

    Returns:
        Path to the generated report.
    """
    lines: List[str] = []
    lines.append("# TAB Anonymization Quality Report — Re-identification Risk Assessment")
    lines.append("")
    lines.append(f"**Generated:** {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    lines.append(f"**Benchmark:** TAB — Text Anonymization Benchmark (arxiv:2202.00443)")
    lines.append(f"**Documents:** {metrics.num_documents} ECHR court cases")
    lines.append(f"**Source:** NorskRegnesentral/text-anonymization-benchmark")
    lines.append("")

    lines.append("## What TAB Measures")
    lines.append("")
    lines.append("Unlike pure detection benchmarks, TAB evaluates **anonymization quality** —")
    lines.append("whether the system correctly identifies which personally identifiable spans")
    lines.append("**need to be masked** to prevent re-identification.")
    lines.append("")
    lines.append("- **DIRECT identifiers**: Must be masked (names, SSNs, direct identifiers)")
    lines.append("- **QUASI identifiers**: Should be masked (dates, locations, quasi-identifiers)")
    lines.append("- **NO_MASK**: Should NOT be masked (publicly known information)")
    lines.append("")

    lines.append("## Summary Scores")
    lines.append("")
    lines.append("| Metric | Value |")
    lines.append("|--------|-------|")
    lines.append(f"| **R_direct** (recall of must-mask) | {metrics.recall_direct:.4f} |")
    lines.append(f"| **R_quasi** (recall of should-mask) | {metrics.recall_quasi:.4f} |")
    lines.append(f"| **F1_direct** | {metrics.f1_direct:.4f} |")
    lines.append(f"| **F1_quasi** | {metrics.f1_quasi:.4f} |")
    lines.append(f"| **Weighted F1** (DIRECT 2×, QUASI 1×) | {metrics.weighted_f1:.4f} |")
    lines.append(f"| **Precision** (of masking decisions) | {metrics.precision:.4f} |")
    lines.append("")

    lines.append("## Detection Quality (masking-agnostic)")
    lines.append("")
    lines.append("| Metric | Value |")
    lines.append("|--------|-------|")
    lines.append(f"| **Detection Precision** | {metrics.detection_precision:.4f} |")
    lines.append(f"| **Detection Recall** | {metrics.detection_recall:.4f} |")
    lines.append(f"| **Detection F1** | {metrics.detection_f1:.4f} |")
    lines.append("")

    lines.append("## Re-identification Risk Assessment")
    lines.append("")
    if metrics.recall_direct >= 0.95:
        lines.append("✅ **LOW RISK** — R_direct ≥ 0.95: Most direct identifiers are correctly masked.")
    elif metrics.recall_direct >= 0.85:
        lines.append("⚠️ **MODERATE RISK** — R_direct between 0.85 and 0.95: Some direct identifiers may leak through.")
    else:
        lines.append("❌ **HIGH RISK** — R_direct < 0.85: Significant risk of re-identification via direct identifiers.")
    lines.append("")

    if metrics.recall_quasi >= 0.80:
        lines.append("✅ **LOW RISK** — R_quasi ≥ 0.80: Most quasi-identifiers are correctly masked.")
    elif metrics.recall_quasi >= 0.65:
        lines.append("⚠️ **MODERATE RISK** — R_quasi between 0.65 and 0.80: Some quasi-identifiers may leak.")
    else:
        lines.append("❌ **HIGH RISK** — R_quasi < 0.65: Quasi-identifiers can combine to enable re-identification.")
    lines.append("")

    # Per-entity breakdown
    if metrics.per_entity:
        lines.append("## Per-Entity Breakdown")
        lines.append("")
        lines.append(
            "| Entity Type | R_direct | R_quasi | F1 | Direct | Quasi | Total |"
        )
        lines.append(
            "|-------------|----------|---------|-----|--------|-------|-------|"
        )
        for entity_type, data in sorted(metrics.per_entity.items()):
            lines.append(
                f"| {entity_type} | {data.get('recall_direct', 0):.4f} "
                f"| {data.get('recall_quasi', 0):.4f} "
                f"| {data.get('f1', 0):.4f} "
                f"| {data.get('direct_count', 0)} "
                f"| {data.get('quasi_count', 0)} "
                f"| {data.get('gold_count', 0)} |"
            )
        lines.append("")

    # Counts
    lines.append("## Annotation Counts")
    lines.append("")
    lines.append("| Category | Count |")
    lines.append("|----------|-------|")
    lines.append(f"| Gold DIRECT (must mask) | {metrics.total_gold_direct} |")
    lines.append(f"| Gold QUASI (should mask) | {metrics.total_gold_quasi} |")
    lines.append(f"| Gold NO_MASK (keep) | {metrics.total_gold_no_mask} |")
    lines.append(f"| Total predicted | {metrics.total_predicted} |")
    lines.append("")

    # Methodology
    lines.append("## Methodology Notes")
    lines.append("")
    lines.append("- **IoU threshold:** 0.5 for span matching")
    lines.append("- **R_direct:** Recall of DIRECT identifiers that were correctly detected")
    lines.append("- **R_quasi:** Recall of QUASI identifiers that were correctly detected")
    lines.append("- **Precision:** Fraction of detected spans that correspond to spans needing masking")
    lines.append("- **Weighted F1:** (2×F1_direct + 1×F1_quasi) / 3 — reflects higher cost of leaking DIRECT identifiers")
    lines.append("- Entity types mapped from TAB's native types (PERSON, ORG, LOC, DATETIME, CODE, DEM)")
    lines.append("")

    report_path = os.path.join(output_dir, "..", "..", "TAB_ANONYMIZATION_REPORT.md")
    report_path = os.path.normpath(report_path)
    os.makedirs(os.path.dirname(report_path), exist_ok=True)
    with open(report_path, "w") as f:
        f.write("\n".join(lines))

    print(f"\nReport saved → {report_path}")
    return report_path


def main() -> None:
    parser = argparse.ArgumentParser(description="TAB Anonymization Evaluation Runner")
    parser.add_argument(
        "--service-url",
        type=str,
        default="http://localhost:3000/analyze",
    )
    parser.add_argument(
        "--splits",
        nargs="+",
        default=["test"],
        choices=["train", "dev", "test"],
    )
    parser.add_argument("--max-documents", type=int, default=None)
    parser.add_argument("--iou-threshold", type=float, default=0.5)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output-dir", type=str, default="benchmarks/tab/results")
    parser.add_argument("--skip-download", action="store_true")
    args = parser.parse_args()

    metrics = run_tab_evaluation(
        service_url=args.service_url,
        splits=args.splits,
        max_documents=args.max_documents,
        iou_threshold=args.iou_threshold,
        seed=args.seed,
        output_dir=args.output_dir,
        skip_download=args.skip_download,
    )

    generate_tab_report(metrics, args.output_dir)


if __name__ == "__main__":
    main()
