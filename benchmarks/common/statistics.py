"""
Statistical significance testing via bootstrap resampling.

Implements the bootstrap method for computing 95% confidence intervals
on benchmark metrics. Uses 10,000 iterations as specified in the plan.

Why bootstrap (not paired t-test):
    Benchmark samples are NOT independent — the same PII types appear
    in multiple samples, and detection accuracy is correlated within
    entity types. Bootstrap resampling is distribution-free and handles
    this correctly.

Methodology:
    1. Resample N evaluation results WITH replacement (N = original size)
    2. Recompute the metric on the resampled set
    3. Repeat 10,000 times
    4. Take the 2.5th and 97.5th percentiles as the 95% CI
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np


@dataclass
class BootstrapResult:
    """Result of bootstrap resampling for a single metric."""

    metric_name: str
    observed: float
    mean: float
    std: float
    ci_lower: float  # 2.5th percentile
    ci_upper: float  # 97.5th percentile
    num_iterations: int

    @property
    def ci_width(self) -> float:
        return self.ci_upper - self.ci_lower

    def to_dict(self) -> Dict:
        return {
            "metric": self.metric_name,
            "observed": round(self.observed, 4),
            "bootstrap_mean": round(self.mean, 4),
            "bootstrap_std": round(self.std, 4),
            "ci_95": [round(self.ci_lower, 4), round(self.ci_upper, 4)],
            "ci_width": round(self.ci_width, 4),
            "iterations": self.num_iterations,
        }


def bootstrap_ci(
    values: List[float],
    statistic_fn: Callable[[List[float]], float] = np.mean,
    num_iterations: int = 10000,
    confidence: float = 0.95,
    seed: int = 42,
) -> BootstrapResult:
    """Compute bootstrap confidence interval for a metric.

    Args:
        values: List of per-sample metric values (e.g., per-sample F₂).
        statistic_fn: Function to compute the statistic (default: mean).
        num_iterations: Number of bootstrap iterations.
        confidence: Confidence level (default: 0.95 for 95% CI).
        seed: Random seed for reproducibility.

    Returns:
        BootstrapResult with observed value, mean, std, and CI.
    """
    rng = np.random.RandomState(seed)
    n = len(values)
    observed = statistic_fn(values)

    # Generate bootstrap samples
    bootstrap_stats: List[float] = []
    for _ in range(num_iterations):
        # Resample with replacement
        indices = rng.choice(n, size=n, replace=True)
        sample = [values[i] for i in indices]
        bootstrap_stats.append(statistic_fn(sample))

    bootstrap_stats.sort()

    # Compute confidence interval
    alpha = 1 - confidence
    lower_idx = int(num_iterations * alpha / 2)
    upper_idx = int(num_iterations * (1 - alpha / 2))

    return BootstrapResult(
        metric_name="bootstrap",
        observed=observed,
        mean=float(np.mean(bootstrap_stats)),
        std=float(np.std(bootstrap_stats)),
        ci_lower=bootstrap_stats[lower_idx],
        ci_upper=bootstrap_stats[upper_idx],
        num_iterations=num_iterations,
    )


def bootstrap_metric_ci(
    predicted_samples: List[list],
    gold_samples: List[list],
    metric_fn: Callable,
    num_iterations: int = 10000,
    confidence: float = 0.95,
    seed: int = 42,
) -> BootstrapResult:
    """Bootstrap confidence interval for a detection metric.

    Resamples the per-sample metric values and recomputes the aggregate.

    Args:
        predicted_samples: List of predicted spans per sample.
        gold_samples: List of gold spans per sample.
        metric_fn: Function(predicted, gold) → float (per-sample metric).
        num_iterations: Bootstrap iterations.
        confidence: Confidence level.
        seed: Random seed.

    Returns:
        BootstrapResult with CI.
    """
    rng = np.random.RandomState(seed)
    n = len(predicted_samples)

    # Compute per-sample metrics
    per_sample: List[float] = []
    for pred, gold in zip(predicted_samples, gold_samples):
        try:
            val = metric_fn(pred, gold)
            per_sample.append(val)
        except Exception:
            per_sample.append(0.0)

    observed = float(np.mean(per_sample))

    # Bootstrap
    bootstrap_stats: List[float] = []
    for _ in range(num_iterations):
        indices = rng.choice(n, size=n, replace=True)
        sample = [per_sample[i] for i in indices]
        bootstrap_stats.append(float(np.mean(sample)))

    bootstrap_stats.sort()

    alpha = 1 - confidence
    lower_idx = int(num_iterations * alpha / 2)
    upper_idx = int(num_iterations * (1 - alpha / 2))

    return BootstrapResult(
        metric_name="metric_ci",
        observed=observed,
        mean=float(np.mean(bootstrap_stats)),
        std=float(np.std(bootstrap_stats)),
        ci_lower=bootstrap_stats[lower_idx],
        ci_upper=bootstrap_stats[upper_idx],
        num_iterations=num_iterations,
    )


def bootstrap_significance_test(
    scores_a: List[float],
    scores_b: List[float],
    num_iterations: int = 10000,
    seed: int = 42,
) -> Dict:
    """Test if two sets of scores are significantly different.

    Uses bootstrap resampling of the difference between means.

    Args:
        scores_a: Per-sample scores for system A.
        scores_b: Per-sample scores for system B.
        num_iterations: Bootstrap iterations.
        seed: Random seed.

    Returns:
        {
            "difference_observed": float,
            "p_value": float,
            "ci_95": [float, float],
            "significant_at_005": bool,
            "significant_at_001": bool,
        }
    """
    rng = np.random.RandomState(seed)
    n = len(scores_a)
    assert len(scores_b) == n

    observed_diff = float(np.mean(scores_a) - np.mean(scores_b))

    # Bootstrap the difference
    diff_samples: List[float] = []
    for _ in range(num_iterations):
        indices = rng.choice(n, size=n, replace=True)
        sample_a = [scores_a[i] for i in indices]
        sample_b = [scores_b[i] for i in indices]
        diff_samples.append(float(np.mean(sample_a) - np.mean(sample_b)))

    diff_samples.sort()

    # Two-tailed p-value
    if observed_diff >= 0:
        p_value = 2 * sum(1 for d in diff_samples if d <= 0) / num_iterations
    else:
        p_value = 2 * sum(1 for d in diff_samples if d >= 0) / num_iterations

    alpha_lower = num_iterations * 0.025
    alpha_upper = num_iterations * 0.975

    return {
        "difference_observed": round(observed_diff, 4),
        "p_value": round(p_value, 6),
        "ci_95": [round(diff_samples[int(alpha_lower)], 4),
                   round(diff_samples[int(alpha_upper)], 4)],
        "significant_at_005": p_value < 0.05,
        "significant_at_001": p_value < 0.01,
    }


def format_significance_report(results: Dict[str, BootstrapResult]) -> str:
    """Format bootstrap results as a Markdown table.

    Args:
        results: Dict of metric_name → BootstrapResult.

    Returns:
        Markdown-formatted string.
    """
    lines: List[str] = []
    lines.append("## Statistical Significance (Bootstrap Resampling)")
    lines.append("")
    lines.append(f"**Iterations:** 10,000 | **Confidence Level:** 95% | **Method:** Non-parametric bootstrap")
    lines.append("")
    lines.append("| Metric | Observed | Mean | Std Dev | 95% CI | CI Width |")
    lines.append("|--------|----------|------|---------|--------|----------|")

    for name, result in results.items():
        lines.append(
            f"| {name} | {result.observed:.4f} | {result.mean:.4f} "
            f"| {result.std:.4f} | [{result.ci_lower:.4f}, {result.ci_upper:.4f}] "
            f"| {result.ci_width:.4f} |"
        )

    lines.append("")
    lines.append("> **Interpretation:** If the 95% CI does not include 0 for a difference metric,")
    lines.append("> the improvement is statistically significant at p < 0.05.")
    lines.append("")

    return "\n".join(lines)
