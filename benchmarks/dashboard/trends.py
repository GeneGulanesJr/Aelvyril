"""
Historical benchmark trend tracker.

Stores per-run benchmark results in a JSONL history file and generates
trend analysis (improvements, regressions, moving averages).

Usage:
    from benchmarks.dashboard.trends import TrendTracker

    tracker = TrendTracker("benchmarks/results")
    tracker.record_run(results)       # Save current run
    tracker.generate_trends_report()  # Markdown trend report
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))


HISTORY_FILE = "trends.jsonl"
MAX_HISTORY = 100  # Keep last 100 runs


class TrendTracker:
    """Tracks benchmark results over time and generates trend reports."""

    def __init__(self, results_dir: str = "benchmarks/results"):
        self.results_dir = results_dir
        self.history_path = os.path.join(results_dir, HISTORY_FILE)
        os.makedirs(results_dir, exist_ok=True)

    def record_run(self, results: Dict[str, Any]) -> None:
        """Append current benchmark run to history.

        Args:
            results: Aggregated results dict (same format as latest.json).
        """
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "sha": self._get_git_sha(),
            "results": results,
        }

        # Load existing history
        history = self._load_history()

        # Append
        history.append(entry)

        # Trim to MAX_HISTORY
        if len(history) > MAX_HISTORY:
            history = history[-MAX_HISTORY:]

        # Write
        with open(self.history_path, "w") as f:
            for line in history:
                f.write(json.dumps(line) + "\n")

    def get_history(self) -> List[Dict[str, Any]]:
        """Load full run history."""
        return self._load_history()

    def generate_trends_report(self) -> str:
        """Generate a Markdown report showing trends across benchmark runs.

        Returns:
            Markdown string with trend tables and analysis.
        """
        history = self._load_history()

        if len(history) < 2:
            return "## Benchmark Trends\n\n_Insufficient data for trend analysis (need ≥2 runs). Run benchmarks multiple times to see trends._\n"

        lines: List[str] = []
        lines.append("## Benchmark Trends")
        lines.append("")
        lines.append(f"**Runs tracked:** {len(history)}")
        lines.append(f"**First run:** {history[0].get('timestamp', 'unknown')}")
        lines.append(f"**Latest run:** {history[-1].get('timestamp', 'unknown')}")
        lines.append("")

        # Per-metric trend table
        lines.append("### Metric Trends (Latest vs Previous)")
        lines.append("")
        lines.append("| Metric | Latest | Previous | Δ | Trend |")
        lines.append("|--------|--------|----------|---|-------|")

        latest = history[-1].get("results", {}).get("benchmarks", {})
        previous = history[-2].get("results", {}).get("benchmarks", {})

        metrics = self._extract_all_metrics(latest)
        trends = []
        for metric_name, latest_val in metrics.items():
            prev_val = self._extract_metric(previous, metric_name)
            if prev_val is not None and latest_val is not None:
                delta = latest_val - prev_val
                if abs(delta) < 0.001:
                    trend = "→"
                elif delta > 0:
                    trend = "🟢 +"
                else:
                    trend = "🔴"
                trends.append((metric_name, latest_val, prev_val, delta, trend))

        # Sort by absolute delta (biggest changes first)
        trends.sort(key=lambda t: abs(t[3]), reverse=True)

        for name, latest_v, prev_v, delta, trend_icon in trends[:20]:  # Top 20
            lines.append(
                f"| {name} | {latest_v:.4f} | {prev_v:.4f} | {delta:+.4f} | {trend_icon} |"
            )

        lines.append("")

        # Run history summary
        lines.append("### Run History")
        lines.append("")
        lines.append("| # | Timestamp | Git SHA | Suites |")
        lines.append("|---|-----------|---------|--------|")

        for i, run in enumerate(history[-10:], 1):  # Last 10 runs
            ts = run.get("timestamp", "?")[:19]
            sha = run.get("sha", "?")[:8]
            suites = list(run.get("results", {}).get("benchmarks", {}).keys())
            lines.append(f"| {i} | {ts} | `{sha}` | {', '.join(suites) if suites else '—'} |")

        lines.append("")

        # Moving averages (last 5 runs)
        if len(history) >= 5:
            lines.append("### Moving Averages (Last 5 Runs)")
            lines.append("")
            lines.append("| Metric | 5-Run Avg | Std Dev | Stability |")
            lines.append("|--------|-----------|---------|-----------|")

            recent = history[-5:]
            metric_values: Dict[str, List[float]] = {}
            for run in recent:
                run_metrics = self._extract_all_metrics(
                    run.get("results", {}).get("benchmarks", {})
                )
                for name, val in run_metrics.items():
                    if val is not None:
                        metric_values.setdefault(name, []).append(val)

            for name, values in sorted(metric_values.items()):
                avg = sum(values) / len(values)
                variance = sum((v - avg) ** 2 for v in values) / len(values)
                std = variance**0.5
                cv = std / avg if avg > 0 else 0  # Coefficient of variation
                if cv < 0.02:
                    stability = "✅ Stable"
                elif cv < 0.05:
                    stability = "⚠️ Moderate"
                else:
                    stability = "🔴 Volatile"
                lines.append(f"| {name} | {avg:.4f} | {std:.4f} | {stability} |")

            lines.append("")

        return "\n".join(lines)

    def _extract_all_metrics(self, benchmarks: Dict[str, Any]) -> Dict[str, float]:
        """Flatten all metrics from a benchmark results dict into {name: value}."""
        metrics: Dict[str, float] = {}

        # Phase 1: Presidio-Research
        pr = benchmarks.get("presidio_research")
        if pr:
            agg = pr.get("aggregate", {})
            for key in ("f2", "f1", "recall", "precision"):
                val = agg.get(key, agg.get(f"{key}_score"))
                if val is not None:
                    metrics[f"presidio_research/{key}"] = float(val)

        # Phase 2: PII-Bench
        pb = benchmarks.get("pii_bench")
        if pb:
            pb_metrics = pb.get("benchmarks", {}).get("pii_bench", {})
            for key in ("strict_f1", "entity_f1", "rouge_l_f", "f2_score"):
                val = pb_metrics.get(key)
                if val is not None:
                    metrics[f"pii_bench/{key}"] = float(val)

        # Phase 2: TAB
        tab = benchmarks.get("tab")
        if tab:
            tab_eval = tab.get("tab_evaluation", {})
            for key in ("recall_direct", "recall_quasi", "weighted_f1"):
                val = tab_eval.get(key)
                if val is not None:
                    metrics[f"tab/{key}"] = float(val)

        # Phase 3: Adversarial
        adv = benchmarks.get("adversarial")
        if adv:
            overall = adv.get("results", {}).get("overall_robustness")
            if overall is not None:
                metrics["adversarial/robustness"] = float(overall)

        # Cross-lingual
        xl = benchmarks.get("cross_lingual")
        if xl:
            agg = xl.get("aggregate", {})
            for key in ("f1", "f2", "precision", "recall"):
                val = agg.get(key)
                if val is not None:
                    metrics[f"cross_lingual/{key}"] = float(val)

        return metrics

    def _extract_metric(self, benchmarks: Dict[str, Any], metric_name: str) -> Optional[float]:
        """Extract a single metric by name from a benchmark results dict."""
        all_metrics = self._extract_all_metrics(benchmarks)
        return all_metrics.get(metric_name)

    def _load_history(self) -> List[Dict[str, Any]]:
        """Load history from JSONL file."""
        if not os.path.exists(self.history_path):
            return []
        history = []
        with open(self.history_path) as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        history.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
        return history

    @staticmethod
    def _get_git_sha() -> str:
        """Get current git SHA, or 'unknown' if not in a git repo."""
        try:
            import subprocess
            result = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                capture_output=True, text=True, timeout=5
            )
            return result.stdout.strip()[:12] if result.returncode == 0 else "unknown"
        except Exception:
            return "unknown"
