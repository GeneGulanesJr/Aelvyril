"""
AelvyrilEvaluator — wraps Aelvyril PII detection pipeline for benchmarking.

Calls the live HTTP endpoint (localhost:3000/analyze) so benchmarks measure
the full production path: Presidio → PiiEngine → overlap resolution →
confidence scoring — not just isolated component performance.

Design decisions:
    - HTTP endpoint ensures we benchmark real-world accuracy
    - Exponential backoff (3 retries) on transient failures
    - Run is invalidated if >1% of calls fail (prevents silent score skew)
    - Schema validation on startup catches version mismatches early
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import requests


# ── Data types ──────────────────────────────────────────────────────────────────


@dataclass
class DetectedSpan:
    """Mirrors Aelvyril's PiiMatch struct."""

    entity_type: str
    text: str
    start: int
    end: int
    score: float


# ── Entity type mapping ─────────────────────────────────────────────────────────

# Map Presidio entity type labels to Aelvyril's PiiType Display names.
# This is the inverse of presidio_entity_to_pii_type() in Rust.
PRESIDIO_TO_AELVYRIL: Dict[str, str] = {
    "EMAIL_ADDRESS": "Email",
    "PHONE_NUMBER": "Phone",
    "IP_ADDRESS": "IP_Address",
    "CREDIT_CARD": "Credit_Card",
    "US_SSN": "SSN",
    "IBAN_CODE": "IBAN",
    "API_KEY": "API_Key",
    "CRYPTO": "API_Key",
    "MEDICAL_LICENSE": "API_Key",
    "URL": "Domain",
    "DOMAIN_NAME": "Domain",
    "DATE_TIME": "Date",
    "DATE": "Date",
    "US_ZIP_CODE": "Zip_Code",
    "ZIP_CODE": "Zip_Code",
    "PERSON": "Person",
    "PER": "Person",
    "LOCATION": "Location",
    "US_STATE": "Location",
    "CITY": "Location",
    "STREET_ADDRESS": "Location",
    "LOC": "Location",
    "ORGANIZATION": "Organization",
    "ORG": "Organization",
    "NRP": "Organization",
}

# Reverse mapping: Aelvyril type → canonical Presidio type
AELVYRIL_TO_PRESIDIO: Dict[str, str] = {}
for k, v in PRESIDIO_TO_AELVYRIL.items():
    if v not in AELVYRIL_TO_PRESIDIO:
        AELVYRIL_TO_PRESIDIO[v] = k


# ── Evaluator ───────────────────────────────────────────────────────────────────


class AelvyrilEvaluator:
    """Wraps Aelvyril PII detection pipeline via its live HTTP endpoint.

    Requires:
        - Aelvyril app running with Presidio service active
        - presidio_service.py listening on localhost:3000 (default)
    """

    DEFAULT_URL = "http://localhost:3000/analyze"
    HEALTH_URL = "http://localhost:3000/health"
    MAX_RETRIES = 3
    RETRY_BACKOFF = [1, 2, 4]  # seconds

    def __init__(self, service_url: str | None = None):
        self.service_url = service_url or self.DEFAULT_URL
        self._failure_count = 0
        self._total_calls = 0
        self._validate_endpoint_schema()

    # ── Public API ──────────────────────────────────────────────────────────

    def predict(self, text: str, language: str = "en") -> List[DetectedSpan]:
        """Send text to Aelvyril's /analyze endpoint and return detected spans.

        Uses exponential backoff on transient failures. Tracks failure rate
        so the benchmark runner can invalidate runs with >1% failures.
        """
        self._total_calls += 1

        for attempt, delay in enumerate(self.RETRY_BACKOFF):
            try:
                resp = requests.post(
                    self.service_url,
                    json={"text": text, "language": language},
                    timeout=10,
                )
                resp.raise_for_status()
                data = resp.json()

                # Parse response format: {"result": [...]}
                results = data.get("result", data) if isinstance(data, dict) else data
                return self._parse_results(results)

            except requests.RequestException as e:
                if attempt < self.MAX_RETRIES - 1:
                    time.sleep(delay)
                    continue
                # All retries exhausted — record failure and return empty
                self._failure_count += 1
                print(f"[WARN] All retries exhausted for sample: {e}")
                return []

        return []

    def predict_sample(self, sample: Any) -> List[DetectedSpan]:
        """Predict from a presidio-evaluator InputSample object."""
        return self.predict(sample.full_text, language="en")

    @property
    def failure_rate(self) -> float:
        """Fraction of calls that failed after all retries."""
        return self._failure_count / max(self._total_calls, 1)

    def is_healthy(self) -> bool:
        """Returns False if >1% of calls failed — benchmark run should be invalidated."""
        return self.failure_rate < 0.01

    def check_service_health(self) -> bool:
        """Check if the Presidio service is reachable."""
        try:
            resp = requests.get(self.HEALTH_URL, timeout=5)
            return resp.status_code == 200
        except requests.RequestException:
            return False

    # ── Internal ────────────────────────────────────────────────────────────

    def _parse_results(self, results: list) -> List[DetectedSpan]:
        """Convert raw JSON results into DetectedSpan objects."""
        spans: List[DetectedSpan] = []
        for m in results:
            entity_type = m.get("entity_type", "UNKNOWN")
            # Map Presidio entity type to Aelvyril type name
            mapped = PRESIDIO_TO_AELVYRIL.get(entity_type, entity_type)
            spans.append(
                DetectedSpan(
                    entity_type=mapped,
                    text=m.get("text", ""),
                    start=m.get("start", 0),
                    end=m.get("end", 0),
                    score=m.get("score", 0.0),
                )
            )
        return spans

    def _validate_endpoint_schema(self) -> None:
        """Verify the /analyze endpoint returns the expected JSON schema.

        Sends a probe request and confirms the response format.
        Raises ValueError if schema mismatches — prevents silent invalid benchmarks.
        """
        try:
            probe = requests.post(
                self.service_url,
                json={"text": "test@example.com", "language": "en"},
                timeout=5,
            )
            probe.raise_for_status()
            data = probe.json()

            # Handle both {"result": [...]} and bare [...] formats
            if isinstance(data, dict):
                results = data.get("result", [])
            elif isinstance(data, list):
                results = data
            else:
                raise ValueError(f"Expected JSON array/object from /analyze, got {type(data)}")

            # If results are present, validate field names
            if results:
                if isinstance(results[0], dict):
                    required = {"entity_type", "start", "end", "score"}
                    missing = required - set(results[0].keys())
                    if missing:
                        raise ValueError(f"/analyze response missing fields: {missing}")
            print("[INFO] Endpoint schema validation passed.")

        except requests.ConnectionError:
            raise ConnectionError(
                f"Cannot connect to {self.service_url}. "
                "Start the Presidio service first: "
                "docker compose -f benchmarks/docker-compose.bench.yml up -d"
            )
