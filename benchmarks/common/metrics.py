"""
F₂ score computation and related metrics for PII detection benchmarks.

Primary metric: F₂ (β=2, recall-weighted) — reflects Aelvyril's threat model
where missing PII is worse than over-redaction.

F₂ = (1 + β²) × (Precision × Recall) / (β² × Precision + Recall)
where β = 2 (recall weighted 2× over precision)

Core supported types:
    Aelvyril can detect 24 entity types split across two mechanisms:

    REGEX_ONLY (10 types): Always available via built-in regex recognizers.
        EMAIL_ADDRESS, PHONE_NUMBER, IP_ADDRESS, CREDIT_CARD, US_SSN,
        IBAN_CODE, API_KEY, URL, DATE_TIME, US_ZIP_CODE.

    NER_DEPENDENT (14 types): Require Presidio NER service integration.
        PERSON, LOCATION, ORGANIZATION, CITY, US_STATE, STREET_ADDRESS,
        COUNTRY, NATIONALITY, TITLE, MEDICAL_RECORD, AGE, SWIFT_CODE,
        US_BANK_NUMBER, US_PASSPORT, US_DRIVER_LICENSE.

    CORE_SUPPORTED_TYPES = REGEX_ONLY | NER_DEPENDENT (all 24 types).
    Use compute_core_aggregate(regex_only=True) to evaluate fallback-only.

    Excluded from evaluation:
      - "NRP" — demographic attributes (gender, race, religion, politics,
        sexuality) that are NOT PII. Excluded from all pipelines.
      - "ID" — generic catch-all (device_identifier, unique_id, customer_id,
        employee_id, vehicle_identifier). No Aelvyril recognizer produces it.

    Gold types not in the core set still appear in per-entity breakdowns
    (for transparency) but are excluded from the core aggregate so
    unsupported types don't deflate the overall score.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple


# ── Core supported types ──────────────────────────────────────────────────
#
# Types Aelvyril can detect, split by detection mechanism:
#
#   REGEX_ONLY: Always available — detected by built-in regex recognizers.
#              These types work even when Presidio NER is unavailable.
#
#   NER_DEPENDENT: Require Presidio NER service. Detected through Aelvyril's
#                  Presidio integration (mapped in presidio.rs). If Presidio
#                  is down, these types have zero recall.
#
# CORE_SUPPORTED_TYPES = union of both sets. Used for the "core aggregate"
# in benchmark reports. All 24 types are in the PiiType enum and have Display
# mappings, so they're part of Aelvyril's canonical namespace.
#
# Important: The core aggregate includes all 24 types because they are all
# *supported* by Aelvyril (when Presidio is available). If Presidio is down,
# use REGEX_ONLY for a fairer aggregate. This is clearly documented so
# aggregate scores are interpretable.

REGEX_ONLY: Set[str] = {
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "IP_ADDRESS",
    "CREDIT_CARD",
    "US_SSN",
    "IBAN_CODE",
    "API_KEY",
    "URL",
    "DATE_TIME",
    "US_ZIP_CODE",
}

NER_DEPENDENT: Set[str] = {
    "PERSON",
    "LOCATION",
    "ORGANIZATION",
    "CITY",
    "US_STATE",
    "STREET_ADDRESS",
    "COUNTRY",
    "NATIONALITY",
    "TITLE",
    "MEDICAL_RECORD",
    "AGE",
    "SWIFT_CODE",
    "US_BANK_NUMBER",
    "US_PASSPORT",
    "US_DRIVER_LICENSE",
}

CORE_SUPPORTED_TYPES: Set[str] = REGEX_ONLY | NER_DEPENDENT


def compute_core_aggregate(
    per_entity: Dict[str, "EntityMetrics"],
    average: str = "micro",
    regex_only: bool = False,
) -> Tuple["EntityMetrics", Set[str]]:
    """Compute aggregate over only the core supported types.

    Args:
        per_entity: Per-entity metrics from evaluate_entity_types().
        average: "micro" or "macro".
        regex_only: If True, only include types detectable by regex
                   (no Presidio NER dependency). Useful for evaluating
                   fallback performance when Presidio is unavailable.

    Returns:
        Tuple of (aggregate EntityMetrics, set of included entity types).
    """
    supported = REGEX_ONLY if regex_only else CORE_SUPPORTED_TYPES
    filtered = {
        k: v for k, v in per_entity.items()
        if k in supported
    }
    included = set(filtered.keys())
    return compute_aggregate(filtered, average=average), included


@dataclass
class SpanMatch:
    """A single detected PII span with entity type and position."""

    entity_type: str
    start: int
    end: int
    score: float = 1.0
    text: str = ""


@dataclass
class EntityMetrics:
    """Per-entity-type evaluation metrics."""

    entity_type: str
    true_positives: int = 0
    false_positives: int = 0
    false_negatives: int = 0
    total_gold: int = 0
    total_predicted: int = 0

    @property
    def precision(self) -> float:
        denom = self.true_positives + self.false_positives
        return self.true_positives / denom if denom > 0 else 0.0

    @property
    def recall(self) -> float:
        denom = self.true_positives + self.false_negatives
        return self.true_positives / denom if denom > 0 else 0.0

    @property
    def f1(self) -> float:
        p, r = self.precision, self.recall
        return 2 * p * r / (p + r) if (p + r) > 0 else 0.0

    @property
    def f2(self) -> float:
        """F₂ score — recall weighted 2× over precision."""
        return fbeta(self.precision, self.recall, beta=2.0)

    def to_dict(self) -> Dict:
        return {
            "entity_type": self.entity_type,
            "precision": round(self.precision, 4),
            "recall": round(self.recall, 4),
            "f1": round(self.f1, 4),
            "f2": round(self.f2, 4),
            "tp": self.true_positives,
            "fp": self.false_positives,
            "fn": self.false_negatives,
            "gold_count": self.total_gold,
            "pred_count": self.total_predicted,
        }


def fbeta(precision: float, recall: float, beta: float = 2.0) -> float:
    """Compute Fβ score.

    Fβ = (1 + β²) × (P × R) / (β² × P + R)
    """
    if precision + recall == 0:
        return 0.0
    beta_sq = beta**2
    return (1 + beta_sq) * (precision * recall) / (beta_sq * precision + recall)


def match_spans(
    predicted: List[SpanMatch],
    gold: List[SpanMatch],
    iou_threshold: float = 0.5,
) -> Tuple[int, int, int]:
    """Match predicted spans against gold spans using IoU overlap.

    Args:
        predicted: List of predicted PII spans.
        gold: List of ground-truth PII spans.
        iou_threshold: Minimum Intersection-over-Union to count as a match.

    Returns:
        (true_positives, false_positives, false_negatives)
    """
    tp = 0
    matched_gold: set = set()

    # Sort predictions by score descending (greedy matching)
    sorted_pred = sorted(predicted, key=lambda s: s.score, reverse=True)

    for pred in sorted_pred:
        best_iou = 0.0
        best_gold_idx = -1

        for gi, g in enumerate(gold):
            if gi in matched_gold:
                continue
            if pred.entity_type != g.entity_type:
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
                best_gold_idx = gi

        if best_iou >= iou_threshold and best_gold_idx >= 0:
            tp += 1
            matched_gold.add(best_gold_idx)

    fp = len(predicted) - tp
    fn = len(gold) - tp

    return tp, fp, fn


def evaluate_entity_types(
    predicted: List[SpanMatch],
    gold: List[SpanMatch],
    iou_threshold: float = 0.5,
) -> Dict[str, EntityMetrics]:
    """Compute per-entity-type metrics from matched spans.

    Returns:
        Dict mapping entity type name → EntityMetrics.
    """
    # Gather all entity types present in either predicted or gold
    all_types: set = set()
    for s in predicted:
        all_types.add(s.entity_type)
    for s in gold:
        all_types.add(s.entity_type)

    results: Dict[str, EntityMetrics] = {}

    for entity_type in sorted(all_types):
        pred_of_type = [s for s in predicted if s.entity_type == entity_type]
        gold_of_type = [s for s in gold if s.entity_type == entity_type]

        tp, fp, fn = match_spans(pred_of_type, gold_of_type, iou_threshold)

        results[entity_type] = EntityMetrics(
            entity_type=entity_type,
            true_positives=tp,
            false_positives=fp,
            false_negatives=fn,
            total_gold=len(gold_of_type),
            total_predicted=len(pred_of_type),
        )

    return results


def compute_aggregate(
    per_entity: Dict[str, EntityMetrics], average: str = "micro"
) -> EntityMetrics:
    """Compute aggregate metrics across all entity types.

    Args:
        per_entity: Per-entity metrics from evaluate_entity_types().
        average: 'micro' (sum TP/FP/FN) or 'macro' (average per-type F₂).
    """
    if average == "micro":
        total_tp = sum(m.true_positives for m in per_entity.values())
        total_fp = sum(m.false_positives for m in per_entity.values())
        total_fn = sum(m.false_negatives for m in per_entity.values())
        return EntityMetrics(
            entity_type="AGGREGATE",
            true_positives=total_tp,
            false_positives=total_fp,
            false_negatives=total_fn,
            total_gold=sum(m.total_gold for m in per_entity.values()),
            total_predicted=sum(m.total_predicted for m in per_entity.values()),
        )
    else:  # macro
        if not per_entity:
            return EntityMetrics(entity_type="AGGREGATE_MACRO")
        f2_scores = [m.f2 for m in per_entity.values()]
        avg_f2 = sum(f2_scores) / len(f2_scores)
        agg = EntityMetrics(entity_type="AGGREGATE_MACRO")
        # Store macro-averaged F₂ in a way that's retrievable
        agg._macro_f2 = avg_f2  # type: ignore[attr-defined]
        return agg
