"""
Error analysis — FP/FN breakdown and confusion matrices.

Provides detailed per-entity-type error analysis including:
    - False positive analysis (over-detected PII)
    - False negative analysis (missed PII)
    - Confusion matrices (predicted vs gold entity types)
    - Per-entity-type breakdown tables

Used in Phase 2, Week 5 (Task 5.3: Error Analysis).
"""

from __future__ import annotations

import json
import os
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from benchmarks.common.metrics import SpanMatch, match_spans


@dataclass
class ErrorInstance:
    """A single false positive or false negative."""

    sample_idx: int
    text: str
    entity_type: str
    start: int
    end: int
    span_text: str = ""
    score: float = 0.0
    # For FPs: what entity type it was confused with (if any overlap with gold)
    confused_with: Optional[str] = None


@dataclass
class ErrorAnalysisResult:
    """Complete error analysis across all samples."""

    total_samples: int = 0
    total_tp: int = 0
    total_fp: int = 0
    total_fn: int = 0

    false_positives: List[ErrorInstance] = field(default_factory=list)
    false_negatives: List[ErrorInstance] = field(default_factory=list)

    # Confusion matrix: predicted_type → gold_type → count
    confusion_matrix: Dict[str, Dict[str, int]] = field(default_factory=lambda: defaultdict(lambda: defaultdict(int)))

    # Per-entity error counts
    per_entity_fp: Dict[str, int] = field(default_factory=lambda: defaultdict(int))
    per_entity_fn: Dict[str, int] = field(default_factory=lambda: defaultdict(int))
    per_entity_tp: Dict[str, int] = field(default_factory=lambda: defaultdict(int))

    def to_dict(self) -> Dict:
        return {
            "total_samples": self.total_samples,
            "counts": {
                "tp": self.total_tp,
                "fp": self.total_fp,
                "fn": self.total_fn,
            },
            "fp_rate": round(self.total_fp / max(self.total_tp + self.total_fp, 1), 4),
            "fn_rate": round(self.total_fn / max(self.total_tp + self.total_fn, 1), 4),
            "per_entity": {
                entity: {
                    "tp": self.per_entity_tp.get(entity, 0),
                    "fp": self.per_entity_fp.get(entity, 0),
                    "fn": self.per_entity_fn.get(entity, 0),
                    "fp_rate": round(
                        self.per_entity_fp.get(entity, 0) /
                        max(self.per_entity_tp.get(entity, 0) + self.per_entity_fp.get(entity, 0), 1),
                        4,
                    ),
                    "fn_rate": round(
                        self.per_entity_fn.get(entity, 0) /
                        max(self.per_entity_tp.get(entity, 0) + self.per_entity_fn.get(entity, 0), 1),
                        4,
                    ),
                }
                for entity in sorted(
                    set(list(self.per_entity_tp.keys()) +
                        list(self.per_entity_fp.keys()) +
                        list(self.per_entity_fn.keys()))
                )
            },
            "confusion_matrix": {
                pred_type: {gold_type: count for gold_type, count in gold_map.items()}
                for pred_type, gold_map in self.confusion_matrix.items()
            },
            "top_fp": [
                {"entity_type": e.entity_type, "text": e.span_text[:100], "score": round(e.score, 3)}
                for e in sorted(self.false_positives, key=lambda x: x.score, reverse=True)[:20]
            ],
            "top_fn": [
                {"entity_type": e.entity_type, "text": e.span_text[:100]}
                for e in self.false_negatives[:20]
            ],
        }


def analyze_errors(
    predicted_samples: List[List[SpanMatch]],
    gold_samples: List[List[SpanMatch]],
    texts: Optional[List[str]] = None,
    iou_threshold: float = 0.5,
) -> ErrorAnalysisResult:
    """Perform detailed error analysis across all samples.

    For each sample, matches predicted against gold spans and categorizes
    unmatched predictions as FPs and unmatched gold spans as FNs.

    Args:
        predicted_samples: List of predicted spans per sample.
        gold_samples: List of gold spans per sample.
        texts: Optional list of source texts (for extracting span text).
        iou_threshold: IoU threshold for matching.

    Returns:
        ErrorAnalysisResult with complete breakdown.
    """
    result = ErrorAnalysisResult(total_samples=len(predicted_samples))

    for sample_idx, (preds, golds) in enumerate(zip(predicted_samples, gold_samples)):
        # Group by entity type for matching
        pred_by_type: Dict[str, List[SpanMatch]] = defaultdict(list)
        gold_by_type: Dict[str, List[SpanMatch]] = defaultdict(list)

        for p in preds:
            pred_by_type[p.entity_type].append(p)
        for g in golds:
            gold_by_type[g.entity_type].append(g)

        all_types = set(list(pred_by_type.keys()) + list(gold_by_type.keys()))

        for entity_type in all_types:
            pred_of_type = pred_by_type.get(entity_type, [])
            gold_of_type = gold_by_type.get(entity_type, [])

            tp, fp, fn = match_spans(pred_of_type, gold_of_type, iou_threshold)

            result.total_tp += tp
            result.total_fp += fp
            result.total_fn += fn

            result.per_entity_tp[entity_type] += tp
            result.per_entity_fp[entity_type] += fp
            result.per_entity_fn[entity_type] += fn

            # Identify specific FP and FN instances
            matched_gold: set = set()
            sorted_pred = sorted(pred_of_type, key=lambda s: s.score, reverse=True)

            for pred in sorted_pred:
                best_iou = 0.0
                best_gi = -1

                for gi, g in enumerate(gold_of_type):
                    if gi in matched_gold:
                        continue

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
                    matched_gold.add(best_gi)
                    result.confusion_matrix[entity_type][entity_type] += 1
                else:
                    # False positive
                    span_text = pred.text
                    if texts and sample_idx < len(texts):
                        text = texts[sample_idx]
                        span_text = text[pred.start:pred.end]

                    # Check if it overlaps with a different entity type
                    confused_with = None
                    if texts and sample_idx < len(texts):
                        for other_type, other_golds in gold_by_type.items():
                            if other_type == entity_type:
                                continue
                            for g in other_golds:
                                overlap_start = max(pred.start, g.start)
                                overlap_end = min(pred.end, g.end)
                                if overlap_end > overlap_start:
                                    confused_with = other_type
                                    result.confusion_matrix[entity_type][other_type] += 1
                                    break
                            if confused_with:
                                break

                    result.false_positives.append(ErrorInstance(
                        sample_idx=sample_idx,
                        text=texts[sample_idx][:200] if texts and sample_idx < len(texts) else "",
                        entity_type=entity_type,
                        start=pred.start,
                        end=pred.end,
                        span_text=span_text,
                        score=pred.score,
                        confused_with=confused_with,
                    ))

            # False negatives: gold spans not matched
            for gi, g in enumerate(gold_of_type):
                if gi not in matched_gold:
                    span_text = g.text
                    if texts and sample_idx < len(texts):
                        text = texts[sample_idx]
                        span_text = text[g.start:g.end]

                    result.false_negatives.append(ErrorInstance(
                        sample_idx=sample_idx,
                        text=texts[sample_idx][:200] if texts and sample_idx < len(texts) else "",
                        entity_type=entity_type,
                        start=g.start,
                        end=g.end,
                        span_text=span_text,
                    ))

    return result


def generate_error_analysis_report(
    analysis: ErrorAnalysisResult,
    output_dir: str = ".",
) -> str:
    """Generate ERROR_ANALYSIS.md report.

    Returns:
        Path to the generated report.
    """
    lines: List[str] = []
    lines.append("# Error Analysis — FP/FN Patterns and Root Causes")
    lines.append("")
    lines.append(f"**Total Samples:** {analysis.total_samples}")
    lines.append(f"**True Positives:** {analysis.total_tp}")
    lines.append(f"**False Positives:** {analysis.total_fp}")
    lines.append(f"**False Negatives:** {analysis.total_fn}")
    lines.append("")

    fp_rate = analysis.total_fp / max(analysis.total_tp + analysis.total_fp, 1)
    fn_rate = analysis.total_fn / max(analysis.total_tp + analysis.total_fn, 1)

    lines.append(f"**FP Rate:** {fp_rate:.4f} ({analysis.total_fp} / {analysis.total_tp + analysis.total_fp})")
    lines.append(f"**FN Rate:** {fn_rate:.4f} ({analysis.total_fn} / {analysis.total_tp + analysis.total_fn})")
    lines.append("")

    # Per-entity error table
    lines.append("## Per-Entity Error Breakdown")
    lines.append("")
    lines.append("| Entity Type | TP | FP | FN | FP Rate | FN Rate |")
    lines.append("|-------------|-----|-----|-----|---------|---------|")

    data = analysis.to_dict()
    for entity_type in sorted(data["per_entity"].keys()):
        ed = data["per_entity"][entity_type]
        lines.append(
            f"| {entity_type} | {ed['tp']} | {ed['fp']} | {ed['fn']} "
            f"| {ed['fp_rate']:.4f} | {ed['fn_rate']:.4f} |"
        )
    lines.append("")

    # Top false positives
    if analysis.false_positives:
        lines.append("## Top False Positives (Over-Detected PII)")
        lines.append("")
        lines.append("These are spans that Aelvyril detected as PII but were NOT in the ground truth:")
        lines.append("")
        lines.append("| # | Entity Type | Span Text | Score | Confused With |")
        lines.append("|---|-------------|-----------|-------|---------------|")

        sorted_fps = sorted(analysis.false_positives, key=lambda x: x.score, reverse=True)
        for idx, fp in enumerate(sorted_fps[:30], 1):
            text_preview = fp.span_text[:60].replace("|", "\\|")
            confused = fp.confused_with or "—"
            lines.append(
                f"| {idx} | {fp.entity_type} | {text_preview} | {fp.score:.3f} | {confused} |"
            )
        lines.append("")

    # Top false negatives
    if analysis.false_negatives:
        lines.append("## Top False Negatives (Missed PII)")
        lines.append("")
        lines.append("These are PII spans that Aelvyril failed to detect:")
        lines.append("")
        lines.append("| # | Entity Type | Span Text |")
        lines.append("|---|-------------|-----------|")

        for idx, fn in enumerate(analysis.false_negatives[:30], 1):
            text_preview = fn.span_text[:80].replace("|", "\\|")
            lines.append(f"| {idx} | {fn.entity_type} | {text_preview} |")
        lines.append("")

    # Confusion matrix
    if analysis.confusion_matrix:
        lines.append("## Confusion Matrix (Predicted → Gold)")
        lines.append("")
        lines.append("Shows entity type confusion — when Aelvyril detected a different type than gold:")
        lines.append("")

        all_types = sorted(set(
            list(analysis.confusion_matrix.keys()) +
            [t for gold_map in analysis.confusion_matrix.values() for t in gold_map.keys()]
        ))

        # Header
        header = "| Predicted \\ Gold | " + " | ".join(all_types) + " |"
        separator = "|---" + "|---" * len(all_types) + "|"
        lines.append(header)
        lines.append(separator)

        for pred_type in all_types:
            row = f"| {pred_type} |"
            for gold_type in all_types:
                count = analysis.confusion_matrix.get(pred_type, {}).get(gold_type, 0)
                row += f" {count} |"
            lines.append(row)
        lines.append("")

    # Root cause analysis
    lines.append("## Root Cause Analysis")
    lines.append("")

    # Identify patterns
    high_fp_types = [
        (t, data["per_entity"][t])
        for t in sorted(data["per_entity"].keys())
        if data["per_entity"][t]["fp_rate"] > 0.15
    ]

    high_fn_types = [
        (t, data["per_entity"][t])
        for t in sorted(data["per_entity"].keys())
        if data["per_entity"][t]["fn_rate"] > 0.15
    ]

    if high_fp_types:
        lines.append("### High False Positive Rate (>15%)")
        lines.append("")
        for entity_type, ed in high_fp_types:
            lines.append(f"- **{entity_type}**: FP rate = {ed['fp_rate']:.1%} ({ed['fp']} FPs)")
        lines.append("")
        lines.append("**Likely causes:**")
        lines.append("- Overly broad regex patterns matching non-PII text")
        lines.append("- Contextual signals not filtering common false positive patterns")
        lines.append("- Entity boundary detection errors (span too wide)")
        lines.append("")

    if high_fn_types:
        lines.append("### High False Negative Rate (>15%)")
        lines.append("")
        for entity_type, ed in high_fn_types:
            lines.append(f"- **{entity_type}**: FN rate = {ed['fn_rate']:.1%} ({ed['fn']} FNs)")
        lines.append("")
        lines.append("**Likely causes:**")
        lines.append("- NER model gaps (misses rare entity formats)")
        lines.append("- Confidence threshold too high for borderline cases")
        lines.append("- Regex patterns not covering all valid formats")
        lines.append("- Code context incorrectly suppressing valid PII matches")
        lines.append("")

    if not high_fp_types and not high_fn_types:
        lines.append("All entity types have error rates below 15%. "
                      "No major systematic issues detected.")
        lines.append("")

    report_path = os.path.join(output_dir, "ERROR_ANALYSIS.md")
    os.makedirs(output_dir, exist_ok=True)
    with open(report_path, "w") as f:
        f.write("\n".join(lines))

    print(f"Error analysis report saved → {report_path}")
    return report_path
