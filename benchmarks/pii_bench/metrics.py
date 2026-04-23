"""
PII-Bench evaluation metrics — Strict-F1, Entity-F1, RougeL-F.

These are the three metrics defined in the PII-Bench paper
(arxiv:2502.18545) for evaluating PII detection accuracy:

    Strict-F1:  Exact span match (predicted start/end must match gold exactly).
    Entity-F1:  Token-level F1 using BIO tagging scheme (partial overlap counted).
    RougeL-F:   Rouge-L based fuzzy matching for partial span detection.

Additionally includes F₂ (recall-weighted) for consistency with
Aelvyril's primary metric.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple


@dataclass
class Span:
    """A text span with character offsets."""

    entity_type: str
    start: int
    end: int
    text: str = ""
    score: float = 1.0

    def __len__(self) -> int:
        return max(0, self.end - self.start)


@dataclass
class PiiBenchMetrics:
    """Aggregated PII-Bench metrics across all samples."""

    strict_f1: float = 0.0
    strict_precision: float = 0.0
    strict_recall: float = 0.0

    entity_f1: float = 0.0
    entity_precision: float = 0.0
    entity_recall: float = 0.0

    rouge_l_f: float = 0.0
    rouge_l_precision: float = 0.0
    rouge_l_recall: float = 0.0

    f2_score: float = 0.0
    f2_recall: float = 0.0
    f2_precision: float = 0.0

    num_samples: int = 0
    per_entity: Dict[str, dict] = field(default_factory=dict)

    def to_dict(self) -> Dict:
        return {
            "strict_f1": round(self.strict_f1, 4),
            "strict_precision": round(self.strict_precision, 4),
            "strict_recall": round(self.strict_recall, 4),
            "entity_f1": round(self.entity_f1, 4),
            "entity_precision": round(self.entity_precision, 4),
            "entity_recall": round(self.entity_recall, 4),
            "rouge_l_f": round(self.rouge_l_f, 4),
            "rouge_l_precision": round(self.rouge_l_precision, 4),
            "rouge_l_recall": round(self.rouge_l_recall, 4),
            "f2_score": round(self.f2_score, 4),
            "f2_recall": round(self.f2_recall, 4),
            "f2_precision": round(self.f2_precision, 4),
            "num_samples": self.num_samples,
            "per_entity": self.per_entity,
        }


# ── Strict F1 ───────────────────────────────────────────────────────────────────


def strict_f1(
    predicted: List[Span],
    gold: List[Span],
    tolerance: int = 0,
) -> Tuple[float, float, float]:
    """Compute Strict-F1 with optional character tolerance.

    A predicted span matches a gold span if:
        - Entity types match
        - |predicted.start - gold.start| <= tolerance
        - |predicted.end - gold.end| <= tolerance

    Args:
        predicted: List of predicted spans.
        gold: List of ground-truth spans.
        tolerance: Character tolerance for boundary matching (0 = exact).

    Returns:
        (precision, recall, f1)
    """
    if not predicted and not gold:
        return 1.0, 1.0, 1.0
    if not predicted:
        return 0.0, 0.0, 0.0
    if not gold:
        return 0.0, 0.0, 0.0

    matched_gold: Set[int] = set()
    tp = 0

    for pred in predicted:
        for gi, g in enumerate(gold):
            if gi in matched_gold:
                continue
            if pred.entity_type != g.entity_type:
                continue
            if (abs(pred.start - g.start) <= tolerance and
                    abs(pred.end - g.end) <= tolerance):
                tp += 1
                matched_gold.add(gi)
                break

    precision = tp / len(predicted)
    recall = tp / len(gold)
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0

    return precision, recall, f1


# ── Entity F1 (Token-level with BIO tagging) ────────────────────────────────────


def _spans_to_bio_tokens(
    spans: List[Span],
    text_length: int,
    token_offsets: Optional[List[Tuple[int, int]]] = None,
) -> List[str]:
    """Convert spans to BIO tag sequence.

    If token_offsets is provided, uses those boundaries.
    Otherwise, uses character-level tokenization (each char = one token).
    """
    tags = ["O"] * text_length

    for span in spans:
        for i in range(span.start, min(span.end, text_length)):
            if i == span.start:
                tags[i] = f"B-{span.entity_type}"
            else:
                tags[i] = f"I-{span.entity_type}"

    return tags


def entity_f1(
    predicted: List[Span],
    gold: List[Span],
    text_length: int,
) -> Tuple[float, float, float]:
    """Compute Entity-F1 using token-level BIO tagging.

    A predicted token is correct if it has the same BIO tag as the gold.
    Partial span overlap is rewarded proportionally.

    Args:
        predicted: List of predicted spans.
        gold: List of ground-truth spans.
        text_length: Length of the source text.

    Returns:
        (precision, recall, f1)
    """
    pred_tags = _spans_to_bio_tokens(predicted, text_length)
    gold_tags = _spans_to_bio_tokens(gold, text_length)

    assert len(pred_tags) == len(gold_tags)

    tp = sum(1 for p, g in zip(pred_tags, gold_tags) if p != "O" and p == g)

    pred_positive = sum(1 for t in pred_tags if t != "O")
    gold_positive = sum(1 for t in gold_tags if t != "O")

    precision = tp / pred_positive if pred_positive > 0 else 0.0
    recall = tp / gold_positive if gold_positive > 0 else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0

    return precision, recall, f1


# ── RougeL-F (Longest Common Subsequence) ────────────────────────────────────────


def _lcs_length(x: str, y: str) -> int:
    """Compute the length of the longest common subsequence."""
    m, n = len(x), len(y)
    if m == 0 or n == 0:
        return 0

    # Space-optimized LCS
    prev = [0] * (n + 1)
    curr = [0] * (n + 1)

    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if x[i - 1] == y[j - 1]:
                curr[j] = prev[j - 1] + 1
            else:
                curr[j] = max(prev[j], curr[j - 1])
        prev, curr = curr, [0] * (n + 1)

    return prev[n]


def rouge_l_f(
    predicted: List[Span],
    gold: List[Span],
) -> Tuple[float, float, float]:
    """Compute RougeL-F using LCS-based fuzzy span matching.

    For each gold span, finds the best-matching predicted span of the
    same type based on text similarity (Rouge-L). A match is counted
    if the Rouge-L F-measure exceeds 0.5.

    Args:
        predicted: List of predicted spans.
        gold: List of ground-truth spans.

    Returns:
        (precision, recall, f1)
    """
    if not predicted and not gold:
        return 1.0, 1.0, 1.0
    if not predicted or not gold:
        return 0.0, 0.0, 0.0

    matched_gold: Set[int] = set()
    matched_pred: Set[int] = set()

    # For each gold span, find best matching predicted span
    for gi, g in enumerate(gold):
        best_score = 0.0
        best_pi = -1

        for pi, p in enumerate(predicted):
            if pi in matched_pred:
                continue
            if p.entity_type != g.entity_type:
                continue

            # Compute Rouge-L F-measure between span texts
            lcs = _lcs_length(g.text, p.text)
            g_len = len(g.text)
            p_len = len(p.text)

            if g_len == 0 and p_len == 0:
                rl_score = 1.0
            elif g_len == 0 or p_len == 0:
                continue
            else:
                rl_recall = lcs / g_len
                rl_precision = lcs / p_len
                rl_score = (2 * rl_precision * rl_recall /
                            (rl_precision + rl_recall)
                            if (rl_precision + rl_recall) > 0 else 0.0)

            if rl_score > best_score:
                best_score = rl_score
                best_pi = pi

        if best_score >= 0.5 and best_pi >= 0:
            matched_gold.add(gi)
            matched_pred.add(best_pi)

    tp = len(matched_gold)
    precision = tp / len(predicted)
    recall = tp / len(gold)
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0

    return precision, recall, f1


# ── F₂ Score ────────────────────────────────────────────────────────────────────


def fbeta_score(precision: float, recall: float, beta: float = 2.0) -> float:
    """Compute Fβ score."""
    if precision + recall == 0:
        return 0.0
    beta_sq = beta ** 2
    return (1 + beta_sq) * (precision * recall) / (beta_sq * precision + recall)


# ── Full Evaluation ─────────────────────────────────────────────────────────────


def evaluate_pii_bench(
    predicted_samples: List[List[Span]],
    gold_samples: List[List[Span]],
    text_lengths: List[int],
    tolerance: int = 0,
) -> PiiBenchMetrics:
    """Run full PII-Bench evaluation across all samples.

    Computes Strict-F1, Entity-F1, RougeL-F, and F₂ across all samples,
    with per-entity-type breakdowns.

    Args:
        predicted_samples: List of predicted spans per sample.
        gold_samples: List of ground-truth spans per sample.
        text_lengths: Text length for each sample (needed for Entity-F1).
        tolerance: Character tolerance for Strict-F1 (0 = exact match).

    Returns:
        PiiBenchMetrics with all computed metrics.
    """
    assert len(predicted_samples) == len(gold_samples) == len(text_lengths)

    # Accumulators for micro-average
    all_pred: List[Span] = []
    all_gold: List[Span] = []

    # Per-entity accumulators
    entity_preds: Dict[str, List[Span]] = defaultdict(list)
    entity_golds: Dict[str, List[Span]] = defaultdict(list)

    for pred_spans, gold_spans, text_len in zip(
        predicted_samples, gold_samples, text_lengths
    ):
        all_pred.extend(pred_spans)
        all_gold.extend(gold_spans)

        for s in pred_spans:
            entity_preds[s.entity_type].append(s)
        for s in gold_spans:
            entity_golds[s.entity_type].append(s)

    # ── Aggregate metrics ──────────────────────────────────────────────────
    s_prec, s_rec, s_f1 = strict_f1(all_pred, all_gold, tolerance)

    # For entity F1, use total text length across all samples
    total_text_len = sum(text_lengths)
    e_prec, e_rec, e_f1 = entity_f1(all_pred, all_gold, total_text_len)

    r_prec, r_rec, r_f1 = rouge_l_f(all_pred, all_gold)

    f2 = fbeta_score(s_prec, s_rec, beta=2.0)

    metrics = PiiBenchMetrics(
        strict_f1=s_f1,
        strict_precision=s_prec,
        strict_recall=s_rec,
        entity_f1=e_f1,
        entity_precision=e_prec,
        entity_recall=e_rec,
        rouge_l_f=r_f1,
        rouge_l_precision=r_prec,
        rouge_l_recall=r_rec,
        f2_score=f2,
        f2_recall=s_rec,
        f2_precision=s_prec,
        num_samples=len(predicted_samples),
    )

    # ── Per-entity metrics ─────────────────────────────────────────────────
    all_entity_types = set(list(entity_preds.keys()) + list(entity_golds.keys()))

    for entity_type in sorted(all_entity_types):
        preds = entity_preds[entity_type]
        golds = entity_golds[entity_type]

        # Estimate text length for this entity type's spans
        max_end = max(
            [s.end for s in preds + golds] + [0]
        )

        sp, sr, sf = strict_f1(preds, golds, tolerance)
        ep, er, ef = entity_f1(preds, golds, max_end)
        rp, rr, rf = rouge_l_f(preds, golds)

        metrics.per_entity[entity_type] = {
            "strict_f1": round(sf, 4),
            "strict_precision": round(sp, 4),
            "strict_recall": round(sr, 4),
            "entity_f1": round(ef, 4),
            "entity_precision": round(ep, 4),
            "entity_recall": round(er, 4),
            "rouge_l_f": round(rf, 4),
            "rouge_l_precision": round(rp, 4),
            "rouge_l_recall": round(rr, 4),
            "f2": round(fbeta_score(sp, sr, beta=2.0), 4),
            "gold_count": len(golds),
            "pred_count": len(preds),
        }

    return metrics
