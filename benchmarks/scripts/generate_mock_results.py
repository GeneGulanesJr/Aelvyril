"""
Generate mock benchmark results for pipeline validation.

Creates latest.json files in each benchmark suite's results/ directory
with realistic values so the dashboard and publication pipeline produce
fully populated deliverables without requiring external dependencies.

Usage:
    python benchmarks/scripts/generate_mock_results.py
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone


def _write(path: str, data: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    print(f"[OK] {path}")


def main() -> None:
    now = datetime.now(timezone.utc).isoformat()

    # Phase 1: Presidio-Research
    presidio = {
        "aelvyril_version": "dev",
        "timestamp": now,
        "aggregate": {
            "f2": 0.9612,
            "recall": 0.9734,
            "precision": 0.9498,
            "f1": 0.9511,
            "tp": 4821,
            "fp": 255,
            "fn": 132,
        },
        "per_entity": {
            "SSN": {"recall": 0.9912, "precision": 0.9934, "f2": 0.9921, "f1": 0.9923, "tp": 412, "fp": 3, "fn": 4},
            "CREDIT_CARD": {"recall": 0.9845, "precision": 0.9789, "f2": 0.9821, "f1": 0.9817, "tp": 398, "fp": 9, "fn": 6},
            "EMAIL": {"recall": 0.9934, "precision": 0.9956, "f2": 0.9942, "f1": 0.9945, "tp": 421, "fp": 2, "fn": 3},
            "PHONE": {"recall": 0.9789, "precision": 0.9654, "f2": 0.9721, "f1": 0.9721, "tp": 389, "fp": 14, "fn": 8},
            "IBAN": {"recall": 0.9967, "precision": 0.9945, "f2": 0.9956, "f1": 0.9956, "tp": 405, "fp": 2, "fn": 1},
            "IP_ADDRESS": {"recall": 0.9654, "precision": 0.9489, "f2": 0.9589, "f1": 0.9571, "tp": 376, "fp": 20, "fn": 13},
            "PERSON": {"recall": 0.9512, "precision": 0.9234, "f2": 0.9412, "f1": 0.9371, "tp": 912, "fp": 76, "fn": 47},
            "LOCATION": {"recall": 0.8723, "precision": 0.9012, "f2": 0.8789, "f1": 0.8865, "tp": 678, "fp": 75, "fn": 99},
            "ORGANIZATION": {"recall": 0.7891, "precision": 0.8345, "f2": 0.8012, "f1": 0.8112, "tp": 534, "fp": 106, "fn": 143},
            "API_KEY": {"recall": 0.9234, "precision": 0.8789, "f2": 0.9089, "f1": 0.9006, "tp": 321, "fp": 44, "fn": 27},
            "DOMAIN": {"recall": 0.9012, "precision": 0.9234, "f2": 0.9067, "f1": 0.9122, "tp": 298, "fp": 25, "fn": 33},
            "DATE": {"recall": 0.8789, "precision": 0.9012, "f2": 0.8834, "f1": 0.8899, "tp": 287, "fp": 32, "fn": 40},
            "ZIP_CODE": {"recall": 0.8912, "precision": 0.9123, "f2": 0.8967, "f1": 0.9017, "tp": 276, "fp": 27, "fn": 34},
        },
    }
    _write("benchmarks/presidio_research/results/latest.json", presidio)

    # Phase 2: Nemotron-PII
    pii_bench = {
        "aelvyril_version": "dev",
        "timestamp": now,
        "data_source": "NVIDIA Nemotron-PII (CC BY 4.0)",
        "benchmarks": {
            "pii_bench": {
                "strict_f1": 0.9012,
                "entity_f1": 0.9189,
                "rouge_l_f": 0.9345,
                "f2_score": 0.9123,
                "per_entity": {
                    "PERSON": {"strict_f1": 0.9234, "entity_f1": 0.9456},
                    "LOCATION": {"strict_f1": 0.8567, "entity_f1": 0.8890},
                    "ORGANIZATION": {"strict_f1": 0.8123, "entity_f1": 0.8456},
                    "EMAIL": {"strict_f1": 0.9912, "entity_f1": 0.9934},
                    "PHONE": {"strict_f1": 0.9789, "entity_f1": 0.9812},
                    "SSN": {"strict_f1": 0.9956, "entity_f1": 0.9967},
                    "CREDIT_CARD": {"strict_f1": 0.9890, "entity_f1": 0.9901},
                },
            }
        },
    }
    _write("benchmarks/pii_bench/results/latest.json", pii_bench)

    # Phase 2: TAB
    tab = {
        "aelvyril_version": "dev",
        "timestamp": now,
        "tab_evaluation": {
            "recall_direct": 0.9623,
            "recall_quasi": 0.8434,
            "weighted_f1": 0.9012,
            "num_documents": 1268,
        },
    }
    _write("benchmarks/tab/results/latest.json", tab)

    # Phase 3: DataFog
    datafog = {
        "aelvyril_version": "dev",
        "timestamp": now,
        "aggregate": {"f2": 0.8456, "recall": 0.8678, "precision": 0.8012, "f1": 0.8234},
        "results": {
            "aelvyril": {"f1": 0.9511, "f2": 0.9612, "recall": 0.9734, "precision": 0.9498},
            "datafog": {"f1": 0.8234, "f2": 0.8456, "recall": 0.8678, "precision": 0.8012},
            "delta_f1": 0.1277,
        },
    }
    _write("benchmarks/supplementary/results/datafog_latest.json", datafog)

    # Phase 3: ai4privacy
    ai4privacy = {
        "aelvyril_version": "dev",
        "timestamp": now,
        "aggregate": {"f2": 0.9589, "recall": 0.9712, "precision": 0.9367, "f1": 0.9489},
        "results": {
            "f2_score": 0.9589,
            "f1_score": 0.9489,
            "recall": 0.9712,
            "precision": 0.9367,
            "num_samples": 2000,
        },
    }
    _write("benchmarks/supplementary/results/ai4privacy_latest.json", ai4privacy)

    # Phase 3: Adversarial
    adversarial = {
        "aelvyril_version": "dev",
        "timestamp": now,
        "attacks": {
            "homoglyph": {"clean_f2": 0.9734, "attacked_f2": 0.9012, "relative_degradation": 7.42},
            "zero_width": {"clean_f2": 0.9734, "attacked_f2": 0.8890, "relative_degradation": 8.67},
            "base64": {"clean_f2": 0.9734, "attacked_f2": 0.9456, "relative_degradation": 2.86},
            "leet": {"clean_f2": 0.9734, "attacked_f2": 0.9234, "relative_degradation": 5.14},
            "separator": {"clean_f2": 0.9734, "attacked_f2": 0.9567, "relative_degradation": 1.72},
            "edge_case": {"clean_f2": 0.9734, "attacked_f2": 0.9345, "relative_degradation": 4.00},
            "bulk": {"clean_f2": 0.9734, "attacked_f2": 0.9678, "relative_degradation": 0.58},
        },
        "results": {
            "overall_robustness": 0.9234,
            "categories": {
                "homoglyph": {
                    "detection_rate_original": 0.9734,
                    "detection_rate_modified": 0.9012,
                    "robustness_score": 0.9256,
                },
                "zero_width": {
                    "detection_rate_original": 0.9734,
                    "detection_rate_modified": 0.8890,
                    "robustness_score": 0.9134,
                },
                "base64": {
                    "detection_rate_original": 0.9734,
                    "detection_rate_modified": 0.9456,
                    "robustness_score": 0.9712,
                },
                "leet": {
                    "detection_rate_original": 0.9734,
                    "detection_rate_modified": 0.9234,
                    "robustness_score": 0.9489,
                },
                "separator": {
                    "detection_rate_original": 0.9734,
                    "detection_rate_modified": 0.9567,
                    "robustness_score": 0.9823,
                },
                "edge_case": {
                    "detection_rate_original": 0.9734,
                    "detection_rate_modified": 0.9345,
                    "robustness_score": 0.9601,
                },
                "bulk": {
                    "detection_rate_original": 0.9734,
                    "detection_rate_modified": 0.9678,
                    "robustness_score": 0.9942,
                },
            },
        },
    }
    _write("benchmarks/supplementary/results/adversarial_latest.json", adversarial)

    # spaCy baseline
    spacy = {
        "aelvyril_version": "dev",
        "timestamp": now,
        "spacy_evaluation": {
            "model": "en_core_web_lg",
            "strict_f1": 0.6234,
            "entity_f1": 0.6789,
            "rouge_l_f": 0.7123,
            "f2_score": 0.6456,
            "per_entity": {
                "PERSON": {"recall": 0.8567, "precision": 0.8123, "f2": 0.8345, "f1": 0.8340},
                "LOCATION": {"recall": 0.7234, "precision": 0.6912, "f2": 0.7089, "f1": 0.7070},
                "ORGANIZATION": {"recall": 0.6123, "precision": 0.5890, "f2": 0.6001, "f1": 0.6004},
            },
        },
    }
    _write("benchmarks/spacy/results/latest.json", spacy)

    print("\n[OK] All mock results generated. Run dashboard + publication to produce deliverables.")


if __name__ == "__main__":
    main()
