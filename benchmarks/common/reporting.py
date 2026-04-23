"""
Shared reporting utilities for benchmark output formatting.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List

from .metrics import EntityMetrics


def format_results_as_markdown(
    per_entity: Dict[str, EntityMetrics],
    aggregate: EntityMetrics,
    title: str = "PII Detection Benchmark Results",
    baseline: Dict[str, Dict] | None = None,
) -> str:
    """Format benchmark results as a Markdown table.

    Args:
        per_entity: Per-entity metrics.
        aggregate: Aggregate micro-averaged metrics.
        title: Report title.
        baseline: Optional baseline comparison {entity_type: {f2, recall, precision}}.
    """
    lines: list[str] = []
    lines.append(f"# {title}")
    lines.append("")
    lines.append(f"**Generated:** {datetime.now(timezone.utc).isoformat()}")
    lines.append(f"**Primary Metric:** F₂ (β=2, recall-weighted)")
    lines.append("")

    # Summary
    lines.append("## Summary")
    lines.append("")
    lines.append(f"| Metric | Value |")
    lines.append(f"|--------|-------|")
    lines.append(f"| **F₂ Score** | {aggregate.f2:.4f} |")
    lines.append(f"| **Recall** | {aggregate.recall:.4f} |")
    lines.append(f"| **Precision** | {aggregate.precision:.4f} |")
    lines.append(f"| **F₁ Score** | {aggregate.f1:.4f} |")
    lines.append(f"| **True Positives** | {aggregate.true_positives} |")
    lines.append(f"| **False Positives** | {aggregate.false_positives} |")
    lines.append(f"| **False Negatives** | {aggregate.false_negatives} |")
    lines.append("")

    # Per-entity table
    lines.append("## Per-Entity Breakdown")
    lines.append("")
    if baseline:
        lines.append(
            "| Entity Type | Recall | Precision | F₂ | F₁ | TP | FP | FN | Baseline F₂ | Δ F₂ |"
        )
        lines.append(
            "|-------------|--------|-----------|----|----|----|----|----|----|------|"
        )
    else:
        lines.append(
            "| Entity Type | Recall | Precision | F₂ | F₁ | TP | FP | FN |"
        )
        lines.append(
            "|-------------|--------|-----------|----|----|----|----|----|"
        )

    for entity_type in sorted(per_entity.keys()):
        m = per_entity[entity_type]
        if baseline and entity_type in baseline:
            base_f2 = baseline[entity_type].get("f2", 0.0)
            delta = m.f2 - base_f2
            delta_str = f"{delta:+.4f}"
            lines.append(
                f"| {entity_type} | {m.recall:.4f} | {m.precision:.4f} | "
                f"{m.f2:.4f} | {m.f1:.4f} | {m.true_positives} | "
                f"{m.false_positives} | {m.false_negatives} | {base_f2:.4f} | {delta_str} |"
            )
        else:
            lines.append(
                f"| {entity_type} | {m.recall:.4f} | {m.precision:.4f} | "
                f"{m.f2:.4f} | {m.f1:.4f} | {m.true_positives} | "
                f"{m.false_positives} | {m.false_negatives} |"
            )

    lines.append("")
    return "\n".join(lines)


def save_results_json(
    per_entity: Dict[str, EntityMetrics],
    aggregate: EntityMetrics,
    output_dir: str,
    aelvyril_version: str = "dev",
    extra_meta: Dict[str, Any] | None = None,
) -> str:
    """Save results as machine-readable JSON.

    Returns:
        Path to the saved file.
    """
    os.makedirs(output_dir, exist_ok=True)

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    filename = f"bench_{timestamp}.json"
    filepath = os.path.join(output_dir, filename)

    result = {
        "aelvyril_version": aelvyril_version,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "aggregate": aggregate.to_dict(),
        "per_entity": {
            k: v.to_dict() for k, v in per_entity.items()
        },
    }
    if extra_meta:
        result["meta"] = extra_meta

    with open(filepath, "w") as f:
        json.dump(result, f, indent=2)

    # Also write a "latest.json" symlink/copy
    latest_path = os.path.join(output_dir, "latest.json")
    with open(latest_path, "w") as f:
        json.dump(result, f, indent=2)

    return filepath


def generate_run_manifest(
    output_dir: str,
    aelvyril_version: str = "dev",
    seed: int = 42,
) -> str:
    """Generate a run_manifest.json capturing the benchmark environment."""
    import platform
    import sys

    manifest = {
        "aelvyril_version": aelvyril_version,
        "python_version": sys.version,
        "platform": platform.platform(),
        "seed": seed,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    os.makedirs(output_dir, exist_ok=True)
    manifest_path = os.path.join(output_dir, "run_manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    return manifest_path
