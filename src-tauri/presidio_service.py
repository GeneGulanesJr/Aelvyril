"""
Aelvyril Presidio Analyzer Service

Lightweight HTTP service wrapping Microsoft Presidio for PII detection.
Designed to run locally alongside the Aelvyril desktop app.

Usage:
    pip install presidio-analyzer presidio-analyzer-legacy presidio-nlp-engine
    python presidio_service.py

Endpoints:
    POST /analyze    — Analyze text for PII entities
    GET  /health     — Health check
    GET  /supported  — List supported entity types
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from flask import Flask, Response, request, jsonify

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("presidio-service")

app = Flask(__name__)

# ── HTTP Status Code Constants ─────────────────────────────────────────────────
# Named constants replace magic numbers so every response is self-documenting.

HTTP_OK = 200
HTTP_BAD_REQUEST = 400
HTTP_INTERNAL_ERROR = 500
HTTP_SERVICE_UNAVAILABLE = 503


# ── Structured Error Types ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class ServiceError:
    """Structured error payload returned by all error responses."""

    error: str
    detail: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {"error": self.error}
        if self.detail is not None:
            d["detail"] = self.detail
        return d


# ── Analyzer Result Type ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RecognizerMatch:
    """A single PII detection result returned to the caller."""

    entity_type: str
    start: int
    end: int
    score: float
    recognizer_name: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "entity_type": self.entity_type,
            "start": self.start,
            "end": self.end,
            "score": self.score,
            "analysis_metadata": {
                "recognizer_name": self.recognizer_name,
            },
        }


# ── Presidio setup ─────────────────────────────────────────────────────────────

_analyzer: Optional[object] = None
_analyzer_error: Optional[str] = None

SUPPORTED_ENTITIES: List[str] = [
    "PERSON",
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "US_SSN",
    "IP_ADDRESS",
    "CREDIT_CARD",
    "IBAN_CODE",
    "US_BANK_NUMBER",
    "US_PASSPORT",
    "UK_NHS",
    "LOCATION",
    "DATE_TIME",
    "US_ZIP_CODE",
    "URL",
    "DOMAIN_NAME",
    "CRYPTO",
    "API_KEY",
    "MEDICAL_LICENSE",
    "NRP",  # National Registration Number
]


def get_analyzer() -> Tuple[Optional[object], Optional[str]]:
    """Lazy-load the Presidio analyzer (supports graceful fallback).

    Returns:
        A tuple of (analyzer_instance_or_None, error_string_or_None).
        On success the analyzer is cached; on failure the error is cached
        so we don't retry on every request.
    """
    global _analyzer, _analyzer_error

    if _analyzer is not None or _analyzer_error is not None:
        return _analyzer, _analyzer_error

    try:
        from presidio_analyzer import AnalyzerEngine

        _analyzer = AnalyzerEngine()
        recs = _analyzer.registry.get_recognizers(
            language="en", entities=SUPPORTED_ENTITIES
        )
        logger.info(
            "Presidio AnalyzerEngine initialized — %d recognizers loaded",
            len(recs),
        )
        return _analyzer, None
    except Exception as exc:
        _analyzer_error = str(exc)
        logger.error("Failed to initialize Presidio: %s", exc)
        logger.error("The service will start but /analyze will return errors.")
        logger.error("Install dependencies: pip install presidio-analyzer")
        return None, _analyzer_error


# ── Request / Response Helpers ──────────────────────────────────────────────────


def _parse_analyze_request(data: Dict[str, Any]) -> Tuple[Optional[ServiceError], str, str, Optional[List[str]], float]:
    """Validate and extract fields from an /analyze request body.

    Returns:
        (error_or_None, text, language, entities, score_threshold)
    """
    text: str = data.get("text", "")
    if not text:
        # Empty text is not an error — just returns zero results.
        return None, "", "en", None, 0.5

    language: str = data.get("language", "en")
    entities: Optional[List[str]] = data.get("entities") or None  # None => all
    score_threshold: float = data.get("score_threshold", 0.5)
    return None, text, language, entities, score_threshold


def _presidio_results_to_matches(results: list) -> List[RecognizerMatch]:
    """Convert Presidio AnalyzerResults into our serialisable ``RecognizerMatch`` list."""
    matches: List[RecognizerMatch] = []
    for r in results:
        recognizer_name: Optional[str] = None
        if hasattr(r, "recognition_metadata") and r.recognition_metadata:
            recognizer_name = getattr(r.recognition_metadata, "recognizer_name", None)
        matches.append(
            RecognizerMatch(
                entity_type=r.entity_type,
                start=r.start,
                end=r.end,
                score=r.score,
                recognizer_name=recognizer_name,
            )
        )
    return matches


# ── Endpoints ──────────────────────────────────────────────────────────────────


@app.route("/health", methods=["GET"])
def health() -> Tuple[Response, int]:
    """Health check — returns analyzer status."""
    analyzer, error = get_analyzer()
    if analyzer is not None:
        return jsonify({"status": "healthy", "presidio": True}), HTTP_OK
    return (
        jsonify({"status": "degraded", "presidio": False, "error": error}),
        HTTP_SERVICE_UNAVAILABLE,
    )


@app.route("/supported", methods=["GET"])
def supported() -> Tuple[Response, int]:
    """List supported entity types."""
    return jsonify({"entities": SUPPORTED_ENTITIES}), HTTP_OK


@app.route("/analyze", methods=["POST"])
def analyze() -> Tuple[Response, int]:
    """Analyze text for PII entities.

    Request body:
        {
            "text": "string",
            "language": "en" (optional),
            "entities": ["EMAIL_ADDRESS", ...] (optional, empty = all),
            "score_threshold": 0.5 (optional)
        }

    Response:
        {
            "result": [
                {
                    "entity_type": "EMAIL_ADDRESS",
                    "start": 0,
                    "end": 20,
                    "score": 0.85,
                    "analysis_metadata": {"recognizer_name": "..."}
                }
            ]
        }
    """
    # ── 1. Analyzer availability ────────────────────────────────────────────
    analyzer, error = get_analyzer()
    if analyzer is None:
        return (
            jsonify(ServiceError("Presidio analyzer not initialized", detail=error).to_dict()),
            HTTP_SERVICE_UNAVAILABLE,
        )

    # ── 2. Parse request ────────────────────────────────────────────────────
    try:
        data = request.get_json(force=True)
    except Exception:
        return (
            jsonify(ServiceError("Invalid JSON body").to_dict()),
            HTTP_BAD_REQUEST,
        )

    parse_err, text, language, entities, score_threshold = _parse_analyze_request(data)
    if parse_err is not None:
        return jsonify(parse_err.to_dict()), HTTP_BAD_REQUEST

    if not text:
        return jsonify({"result": []}), HTTP_OK

    # ── 3. Run analysis ─────────────────────────────────────────────────────
    try:
        results = analyzer.analyze(
            text=text,
            language=language,
            entities=entities,
            score_threshold=score_threshold,
        )
        matches = _presidio_results_to_matches(results)
        return jsonify({"result": [m.to_dict() for m in matches]}), HTTP_OK

    except Exception as exc:
        logger.error("Analysis failed: %s", exc, exc_info=True)
        return (
            jsonify(ServiceError("Analysis failed", detail=str(exc)).to_dict()),
            HTTP_INTERNAL_ERROR,
        )


# ── Main ───────────────────────────────────────────────────────────────────────


if __name__ == "__main__":
    host: str = os.environ.get(
        "AELVYRIL_PRESIDIO_HOST", os.environ.get("PRESIDIO_HOST", "127.0.0.1")
    )
    port: int = int(
        os.environ.get(
            "AELVYRIL_PRESIDIO_PORT", os.environ.get("PRESIDIO_PORT", "3000")
        )
    )
    debug: bool = os.environ.get("PRESIDIO_DEBUG", "false").lower() == "true"

    # Pre-warm the analyzer
    get_analyzer()

    logger.info("Starting Presidio service on http://%s:%d", host, port)
    app.run(host=host, port=port, debug=debug)