"""
AelvyrilEvaluator — wraps Aelvyril PII detection pipeline for benchmarking.

Calls the live gateway HTTP endpoint (/v1/chat/completions) so benchmarks measure
the full production path: authentication → rate limiting → PII detection (Presidio
+ custom recognizers) → overlap resolution → confidence scoring → deduplication
→ pseudonymization → rehydration.

Design decisions:
  - Gateway endpoint ensures we benchmark real-world accuracy (not just a component)
  - Exponential backoff (3 retries) on transient failures
  - Run invalidated if >1% of calls fail (prevents silent score skew)
  - Special header X-Benchmark-Mode: raw-detections fetches PII spans without
    streaming completion, keeping payload small and deterministic

Entity type strategy (v3 — unified Presidio uppercase namespace):
  - The gateway outputs Presidio entity types in UPPER_SNAKE_CASE (e.g., EMAIL_ADDRESS,
    PHONE_NUMBER, STREET_ADDRESS) via `PiiType::Display`.
  - Gold datasets also use UPPER_SNAKE_CASE (e.g., EMAIL_ADDRESS, US_SSN, CITY).
  - Scoring compares identical type strings on both sides — simple equality.
  - DISPLAY_NAMES maps UPPER_SNAKE_CASE → human-readable for reports only,
    never for scoring.  Keeps backward compat with code that still uses display
    names internally (e.g., llama/detector.rs `label_to_pii_type`).
"""

from __future__ import annotations


GATEWAY_BENCHMARK_KEY = "aelvyril-benchmark-key"
import json
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import requests


# ── Data types ──────────────────────────────────────────────────────────────────

@dataclass
class DetectedSpan:
    """Mirrors Aelvyril's PiiMatch struct (for benchmark comparisons)."""

    entity_type: str
    text: str
    start: int
    end: int
    score: float


# ── Entity type display names (for reports only — NOT for scoring) ──────────────
#
# These map UPPER_SNAKE_CASE Presidio types (what the gateway actually outputs)
# to human-readable display names for pretty reports and console output.
#
# IMPORTANT: These names MUST NOT be used for entity matching in metrics — that
# causes many-to-one collapses (e.g., CITY + STREET_ADDRESS → Location) that
# artificially inflate/deflate scores. Scoring always uses the raw uppercase
# strings from both predictions and gold annotations.

DISPLAY_NAMES: Dict[str, str] = {
    # Core PII
    "EMAIL_ADDRESS": "Email",
    "PHONE_NUMBER": "Phone",
    "IP_ADDRESS": "IP Address",
    "CREDIT_CARD": "Credit Card",
    "US_SSN": "SSN",
    "IBAN_CODE": "IBAN",
    "API_KEY": "API Key",
    "URL": "URL",
    "DATE_TIME": "Date/Time",
    "US_ZIP_CODE": "Zip Code",
    "ZIP_CODE": "Zip Code",
    # NER types
    "PERSON": "Person",
    "PER": "Person",
    "LOCATION": "Location",
    "LOC": "Location",
    "US_STATE": "US State",
    "CITY": "City",
    "STREET_ADDRESS": "Street Address",
    "COUNTRY": "Country",
    "ORGANIZATION": "Organization",
    "ORG": "Organization",
    "NRP": "NRP",
    # Fine-grained
    "SWIFT_CODE": "SWIFT Code",
    "US_BANK_NUMBER": "US Bank Number",
    "US_PASSPORT": "US Passport",
    "US_DRIVER_LICENSE": "US Driver License",
    "MEDICAL_RECORD": "Medical Record",
    "AGE": "Age",
    "TITLE": "Title",
    "NATIONALITY": "Nationality",
    # Custom passthrough
    "DOMAIN_NAME": "Domain",
}

# ── Backward compatibility aliases ─────────────────────────────────────────────
# These are kept so existing code that imports them doesn't break, but they
# should NOT be used for scoring. New code should use DISPLAY_NAMES for
# display-only purposes and leave scoring types as raw Presidio types.

PRESIDIO_TO_AELVYRIL = DISPLAY_NAMES  # DEPRECATED: use DISPLAY_NAMES for display only

# AELVYRIL_TO_PRESIDIO is no longer needed — predictions stay in Presidio namespace.
# Provide a minimal compat dict that maps display names back to their first Presidio
# type, for any legacy code that still references it.
AELVYRIL_TO_PRESIDIO: Dict[str, str] = {
    "Email": "EMAIL_ADDRESS",
    "Phone": "PHONE_NUMBER",
    "IP_Address": "IP_ADDRESS",
    "Credit_Card": "CREDIT_CARD",
    "SSN": "US_SSN",
    "IBAN": "IBAN_CODE",
    "API_Key": "API_KEY",
    "URL": "URL",
    "Domain": "DOMAIN_NAME",
    "Date": "DATE_TIME",
    "Zip_Code": "US_ZIP_CODE",
    "Person": "PERSON",
    "Location": "LOCATION",
    "Organization": "ORGANIZATION",
}


def display_name(entity_type: str) -> str:
    """Get human-readable display name for an entity type.

    For reports and console output only — never use for scoring.
    Unknown types are returned as-is (uppercase is already the canonical form).
    """
    return DISPLAY_NAMES.get(entity_type, entity_type)


# ── Evaluator ───────────────────────────────────────────────────────────────────

class AelvyrilEvaluator:
    """
    Wraps Aelvyril gateway via its real HTTP endpoint.

    Endpoint: POST /v1/chat/completions
    Header:  X-Benchmark-Mode: raw-detections  (returns PII spans only, no LLM)
    Body:   {"messages": [{"role": "user", "content": "<text>"}]}

    The gateway reciprocates with:
      - 200 + JSON body containing "pii_spans" + "pseudonymized_text"
      - Raw spans using Presidio entity types (no canonicalization)
    """

    DEFAULT_URL = "http://localhost:4242/v1/chat/completions"
    HEALTH_URL = "http://localhost:4242/health"
    MAX_RETRIES = 3
    RETRY_BACKOFF = [1, 2, 4]  # seconds

    def __init__(self, service_url: str | None = None, gateway_key: str | None = None):
        self.service_url = service_url or self.DEFAULT_URL
        self._failure_count = 0
        self._total_calls = 0
        self.gateway_key = gateway_key or GATEWAY_BENCHMARK_KEY
        self._validate_endpoint_schema()

    # ── Public API ──────────────────────────────────────────────────────────

    def predict(self, text: str, language: str = "en") -> List[DetectedSpan]:
        """
        Send text to Aelvyril gateway and return detected PII spans.

        Entity types are returned as raw Presidio types (e.g., EMAIL_ADDRESS,
        PHONE_NUMBER, STREET_ADDRESS). No canonicalization or display-name
        mapping is applied — the types are directly comparable to gold
        annotations mapped to the same Presidio namespace.

        Uses exponential backoff on transient failures. Tracks failure rate
        so the benchmark runner can invalidate runs with >1% failures.
        """
        self._total_calls += 1

        for attempt, delay in enumerate(self.RETRY_BACKOFF):
            try:
                if self._is_chat_endpoint():
                    headers = {
                        "X-Benchmark-Mode": "raw-detections",
                        "Authorization": f"Bearer {self.gateway_key}",
                    }
                    payload = {
                        "messages": [{"role": "user", "content": text}],
                        "model": "none",
                    }
                    resp = requests.post(
                        self.service_url,
                        headers=headers,
                        json=payload,
                        timeout=10,
                    )
                    resp.raise_for_status()
                    data = resp.json()
                    spans_data = data.get("pii_spans", [])
                    return self._parse_results(spans_data)
                else:
                    resp = requests.post(
                        self.service_url,
                        json={"text": text, "language": language},
                        timeout=10,
                    )
                    resp.raise_for_status()
                    data = resp.json()
                    results = data.get("result", data) if isinstance(data, dict) else data
                    return self._parse_results(results)

            except requests.RequestException as e:
                if attempt < self.MAX_RETRIES - 1:
                    time.sleep(delay)
                    continue
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
        """Returns False if >1% of calls failed — benchmark run invalidated."""
        return self.failure_rate < 0.01

    def check_service_health(self) -> bool:
        """Check if the gateway is reachable and healthy."""
        try:
            resp = requests.get(self.HEALTH_URL, timeout=5)
            if resp.status_code == 200:
                data = resp.json()
                return data.get("status") == "ok" and data.get("pii_engine") == "ready"
            return False
        except requests.RequestException:
            return False

    # ── Internal ─────────────────────────────────────────────────────────────

    def _parse_results(self, results: list) -> List[DetectedSpan]:
        """Convert raw JSON results into DetectedSpan objects.

        Preserves original Presidio entity types — no mapping applied.
        """
        spans: List[DetectedSpan] = []
        for m in results:
            entity_type = m.get("entity_type", "UNKNOWN")
            spans.append(
                DetectedSpan(
                    entity_type=entity_type,
                    text=m.get("text", ""),
                    start=m.get("start", 0),
                    end=m.get("end", 0),
                    score=m.get("confidence", m.get("score", 0.0)),
                )
            )
        return spans

    def _is_chat_endpoint(self) -> bool:
        """Return True if service_url points to /v1/chat/completions endpoint."""
        return "/v1/chat/completions" in self.service_url

    def _validate_endpoint_schema(self) -> None:
        """Verify the endpoint returns expected JSON schema.

        Sends a probe with appropriate format for the endpoint type.
        Raises ValueError if schema mismatches — prevents silent invalid benchmarks.
        """
        try:
            if self._is_chat_endpoint():
                probe = requests.post(
                    self.service_url,
                    headers={
                        "X-Benchmark-Mode": "raw-detections",
                        "Authorization": f"Bearer {self.gateway_key}",
                    },
                    json={"messages": [{"role": "user", "content": "test@example.com"}], "model": "none"},
                    timeout=5,
                )
                probe.raise_for_status()
                data = probe.json()
                spans = data.get("pii_spans")
                if spans is None:
                    raise ValueError("Response missing 'pii_spans' field — is X-Benchmark-Mode header being processed?")
                if spans and isinstance(spans[0], dict):
                    required = {"entity_type", "start", "end", "score", "text"}
                    missing = required - set(spans[0].keys())
                    if missing:
                        raise ValueError(f"PII span missing required fields: {missing}")
            else:
                probe = requests.post(
                    self.service_url,
                    json={"text": "test@example.com", "language": "en"},
                    timeout=5,
                )
                probe.raise_for_status()
                data = probe.json()
                results = data.get("result", data) if isinstance(data, dict) else data
                if not isinstance(results, list):
                    raise ValueError(f"Expected JSON array from /analyze, got {type(results)}")
                if results and isinstance(results[0], dict):
                    required = {"entity_type", "start", "end", "score"}
                    missing = required - set(results[0].keys())
                    if missing:
                        raise ValueError(f"/analyze response missing fields: {missing}")

            print("[INFO] Endpoint schema validation passed.")

        except requests.ConnectionError:
            raise ConnectionError(
                f"Cannot connect to {self.service_url}. "
                "Start the Aelvyril gateway first: "
                "cargo run --bin aelvyril-headless"
            )

    # ── Raw prediction access ────────────────────────────────────────────────────

    def predict_raw(self, text: str, language: str = "en") -> List[dict]:
        """Return raw span dicts from the gateway.

        Now identical to predict() in terms of entity type handling
        (no mapping applied). Returns dicts instead of DetectedSpan objects.
        """
        self._total_calls += 1

        for attempt, delay in enumerate(self.RETRY_BACKOFF):
            try:
                if self._is_chat_endpoint():
                    headers = {
                        "X-Benchmark-Mode": "raw-detections",
                        "Authorization": f"Bearer {self.gateway_key}",
                    }
                    payload = {
                        "messages": [{"role": "user", "content": text}],
                        "model": "none",
                    }
                    resp = requests.post(
                        self.service_url,
                        headers=headers,
                        json=payload,
                        timeout=10,
                    )
                    resp.raise_for_status()
                    data = resp.json()
                    return data.get("pii_spans", [])
                else:
                    resp = requests.post(
                        self.service_url,
                        json={"text": text, "language": language},
                        timeout=10,
                    )
                    resp.raise_for_status()
                    data = resp.json()
                    results = data.get("result", data) if isinstance(data, dict) else data
                    return results  # type: ignore[return-value]

            except requests.RequestException as e:
                if attempt < self.MAX_RETRIES - 1:
                    time.sleep(delay)
                    continue
                self._failure_count += 1
                print(f"[WARN] All retries exhausted for sample: {e}")
                return []

        return []
