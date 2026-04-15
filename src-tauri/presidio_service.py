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

import json
import logging
import os
import sys
from dataclasses import dataclass, field
from typing import List, Optional

from flask import Flask, request, jsonify
from flask_cors import CORS

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("presidio-service")

app = Flask(__name__)
CORS(app)

# ── Presidio setup ─────────────────────────────────────────────────────────────

_analyzer = None
_analyzer_error: Optional[str] = None

SUPPORTED_ENTITIES = [
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


def get_analyzer():
    """Lazy-load the Presidio analyzer (supports graceful fallback)."""
    global _analyzer, _analyzer_error

    if _analyzer is not None or _analyzer_error is not None:
        return _analyzer, _analyzer_error

    try:
        from presidio_analyzer import AnalyzerEngine

        _analyzer = AnalyzerEngine()
        all_entities = ["PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER", "US_SSN",
                        "CREDIT_CARD", "IP_ADDRESS", "IBAN_CODE", "URL",
                        "DOMAIN_NAME", "LOCATION", "DATE_TIME", "CRYPTO",
                        "API_KEY", "MEDICAL_LICENSE", "NRP", "US_PASSPORT",
                        "UK_NHS", "US_BANK_NUMBER", "US_ZIP_CODE"]
        recs = _analyzer.registry.get_recognizers(language="en", entities=all_entities)
        logger.info(
            "Presidio AnalyzerEngine initialized — %d recognizers loaded",
            len(recs),
        )
        return _analyzer, None
    except Exception as e:
        _analyzer_error = str(e)
        logger.error("Failed to initialize Presidio: %s", e)
        logger.error("The service will start but /analyze will return errors.")
        logger.error("Install dependencies: pip install presidio-analyzer")
        return None, _analyzer_error


# ── Endpoints ──────────────────────────────────────────────────────────────────


@app.route("/health", methods=["GET"])
def health():
    """Health check — returns analyzer status."""
    analyzer, error = get_analyzer()
    if analyzer is not None:
        return jsonify({"status": "healthy", "presidio": True}), 200
    return jsonify({"status": "degraded", "presidio": False, "error": error}), 503


@app.route("/supported", methods=["GET"])
def supported():
    """List supported entity types."""
    return jsonify({"entities": SUPPORTED_ENTITIES})


@app.route("/analyze", methods=["POST"])
def analyze():
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
                    "analysis_metadata": {}
                }
            ]
        }
    """
    analyzer, error = get_analyzer()
    if analyzer is None:
        return (
            jsonify(
                {
                    "error": "Presidio analyzer not initialized",
                    "detail": error,
                }
            ),
            503,
        )

    try:
        data = request.get_json(force=True)
    except Exception:
        return jsonify({"error": "Invalid JSON body"}), 400

    text = data.get("text", "")
    if not text:
        return jsonify({"result": []})

    language = data.get("language", "en")
    entities = data.get("entities") or None  # None = all
    score_threshold = data.get("score_threshold", 0.5)

    try:
        results = analyzer.analyze(
            text=text,
            language=language,
            entities=entities,
            score_threshold=score_threshold,
        )

        # Convert to serializable format
        response_results = []
        for r in results:
            recognizer_name = None
            if hasattr(r, 'recognition_metadata') and r.recognition_metadata:
                recognizer_name = getattr(r.recognition_metadata, 'recognizer_name', None)
            response_results.append(
                {
                    "entity_type": r.entity_type,
                    "start": r.start,
                    "end": r.end,
                    "score": r.score,
                    "analysis_metadata": {
                        "recognizer_name": recognizer_name,
                    },
                }
            )

        return jsonify({"result": response_results})

    except Exception as e:
        logger.error("Analysis failed: %s", e, exc_info=True)
        return jsonify({"error": "Analysis failed", "detail": str(e)}), 500


# ── Main ───────────────────────────────────────────────────────────────────────


if __name__ == "__main__":
    host = os.environ.get("PRESIDIO_HOST", "127.0.0.1")
    port = int(os.environ.get("PRESIDIO_PORT", "3000"))
    debug = os.environ.get("PRESIDIO_DEBUG", "false").lower() == "true"

    # Pre-warm the analyzer
    get_analyzer()

    logger.info("Starting Presidio service on http://%s:%d", host, port)
    app.run(host=host, port=port, debug=debug)
