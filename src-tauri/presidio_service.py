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
from presidio_analyzer import AnalyzerEngine, EntityRecognizer, RecognizerResult, Pattern
from presidio_analyzer import PatternRecognizer
from presidio_analyzer.predefined_recognizers import SpacyRecognizer, EmailRecognizer, IbanRecognizer, IpRecognizer


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
    "ORGANIZATION",  # <-- now supported via custom recognizer
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

    Uses the default AnalyzerEngine to get all built-in recognizers (Spacy for
    PERSON/LOCATION/DATE_TIME, Email, IP, etc.), then injects our custom
    recognizers into both the registry and the engine's active _recognizers list.
    """
    global _analyzer, _analyzer_error

    if _analyzer is not None or _analyzer_error is not None:
        return _analyzer, _analyzer_error

    try:
        from presidio_analyzer import AnalyzerEngine

        _analyzer = AnalyzerEngine()
        # Inject custom recognizers after engine is fully initialised
        _register_custom_recognizers(_analyzer)
        logger.info("Custom recognizers injected – proceeding to NLP config tweak")
        logger.info(f"NLP engine type: {type(_analyzer.nlp_engine).__name__}")
        if hasattr(_analyzer.nlp_engine, 'ner_model_configuration'):
            cfg = _analyzer.nlp_engine.ner_model_configuration
            logger.info(f"NLP config labels_to_ignore BEFORE: {cfg.labels_to_ignore}")
            # Only modify if ORGANIZATION is in the ignore list
            if 'ORGANIZATION' in cfg.labels_to_ignore:
                cfg.labels_to_ignore = [lbl for lbl in cfg.labels_to_ignore if lbl != 'ORGANIZATION']
                logger.info(f"Removed ORGANIZATION from ner_model_configuration.labels_to_ignore. Now: {cfg.labels_to_ignore}")
            else:
                logger.info("ORGANIZATION not in labels_to_ignore; no change needed")
        else:
            logger.warning("NLP engine has no ner_model_configuration attribute")
        # Remove default SpacyRecognizer to prevent duplicate ORGANIZATION predictions
        # Downgrade SpacyRecognizer: drop ORGANIZATION to avoid duplicate with CustomSpacyOrganizationRecognizer
        for _r in getattr(_analyzer.registry, "recognizers", []):
            if getattr(_r, "name", None) == "SpacyRecognizer":
                _r.supported_entities = [e for e in getattr(_r, "supported_entities", []) if e != "ORGANIZATION"]
        # DEBUG: log recognizers and their supported entities
        for _r in _analyzer.registry.recognizers:
            logger.info(f"Recognizer: {_r.name}, supported: {getattr(_r, 'supported_entities', None)}")
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
            recognizer_name = r.recognition_metadata.get("recognizer_name") if isinstance(r.recognition_metadata, dict) else getattr(r.recognition_metadata, "recognizer_name", None)
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


# ═══════════════════════════════════════════════════════════════════════════════
# Custom Aelvyril Recognizers
# ═══════════════════════════════════════════════════════════════════════════════

class CustomSpacyOrganizationRecognizer(EntityRecognizer):
    """Extract ORGANIZATION entities using spaCy's NER.

    The default ``SpacyRecognizer`` bundled with Presidio only exposes
    ``DATE_TIME``, ``PERSON``, ``LOCATION`` and ``NRP``. This recognizer
    explicitly adds support for ORG labels (e.g. Google, Microsoft).
    """

    def __init__(self, supported_language: str = "en", ner_strength: float = 0.85):
        super().__init__(
            supported_entities=["ORGANIZATION"],
            name="CustomSpacyOrganizationRecognizer",
            supported_language=supported_language,
            version="0.0.1",
            context=["company", "organization", "corp", "inc", "non-profit"],
        )
        self.ner_strength = ner_strength

    def load(self) -> None:
        # No explicit load — NLP artifacts are passed to analyze()
        pass

    def analyze(self, text: str, entities: List[str], nlp_artifacts: Any, language: str = "en", **kwargs) -> List[Any]:
        from presidio_analyzer.nlp_engine import NlpArtifacts  # noqa: F401

        results = []
        # Denylist of short acronyms/terms spaCy often mis-tags as ORG but are not organizations
        ORG_DENYLIST = {
            "api", "cpu", "gpu", "ram", "sql", "html", "css", "json", "xml", "url", "uri",
            "ipsum", "lorem", "etc", "ie", "eg", "vs", "via", "na", "faq", "sdk", "cli",
        }
        for ent in nlp_artifacts.entities:
            if getattr(ent, 'label_', None) == "ORGANIZATION" and (entities is None or "ORGANIZATION" in entities):
                span_text = ent.text.strip()
                # Filter out pure short acronyms (≤4 chars) that are not real organizations
                if len(span_text) <= 4 and span_text.lower() in ORG_DENYLIST:
                    continue
                results.append(RecognizerResult(
                    entity_type="ORGANIZATION",
                    start=ent.start_char,
                    end=ent.end_char,
                    score=self.ner_strength,
                    recognition_metadata={"recognizer_name": self.name}
                ))
        return results


class CustomPhoneNumberRecognizer(EntityRecognizer):
    """Comprehensive PHONE_NUMBER detection with global formats.

    Covers:
      • US/CA: (###) ###-####  or  ###-###-####
      • International: +<country-code> <number>
      • Common separators: space / dash / dot / parentheses
    """

    PHONE_PATTERNS = [
        # (NXX) NXX-XXXX  with optional country code
        r"\(\+?1\)\s?\([2-9]\d{2}\)\s?[2-9]\d{2}-?\d{4}",
        r"\+1\s?\([2-9]\d{2}\)\s?[2-9]\d{2}-?\d{4}",
        r"\([2-9]\d{2}\)\s?[2-9]\d{2}-?\d{4}",
        #  ###-###-####  (no parentheses, optional country code)
        r"\+?1?[-.\s]?\(?[2-9]\d{2}\)?[-.\s]?[2-9]\d{2}[-.\s]?\d{4}",
        # International: +CC NNNN NNNNNNN...
        r"\+\d{1,3}(?:[-.\s]?\d+)+",
        # Simple 10-digit: 555-123-4567 or 555.123.4567 or 5551234567
        r"\b[2-9]\d{2}[-.\s]?[2-9]\d{2}[-.\s]?\d{4}\b",
    ]

    def __init__(self, supported_language: str = "en"):
        super().__init__(
            supported_entities=["PHONE_NUMBER"],
            name="CustomPhoneNumberRecognizer",
            supported_language=supported_language,
            version="1.0.0",
            context=["phone", "call", "mobile", "tel", "telephone"],
        )

    def load(self) -> None:
        pass  # regex loaded on first analyze

    def analyze(self, text: str, entities: List[str], nlp_artifacts: Any, language: str = "en", **kwargs) -> List[Any]:
        import re
        results = []
        # entities=None means "all types are requested"
        if entities is not None and "PHONE_NUMBER" not in entities:
            return []

        # Try each regex pattern
        for pattern_str in self.PHONE_PATTERNS:
            for m in re.finditer(pattern_str, text, re.IGNORECASE):
                start, end = m.span()
                results.append(
                    RecognizerResult(
                        entity_type="PHONE_NUMBER",
                        start=start,
                        end=end,
                        score=0.85,
                        recognition_metadata={"recognizer_name": self.name},
                    )
                )
        return results


class CustomApiKeyRecognizer(PatternRecognizer):
    """Detect API keys using patterns aligned with Aelvyril's Rust recognizers.

    Primary pattern (from Aelvyril's PUBLIC_API_KEY_RE):
        \\b(sk|sk-|sk_|sk-p|sk-proj)-?[A-Za-z0-9]{20,}\\b

    Extended with common provider prefixes (GitHub, Google, AWS, etc.).
    """

    DEFAULT_PATTERNS = [
        Pattern(
            name="openai_api_key",
            score=0.99,
            regex=r"\b(sk|sk-|sk_|sk-p|sk-proj)-?[A-Za-z0-9]{20,}\b",
            
        ),
        Pattern(
            name="github_pat",
            score=0.98,
            regex=r"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{22,}\b",
            
        ),
        Pattern(
            name="google_api_key",
            score=0.98,
            regex=r"\bAIza[0-9A-Za-z\-_]{35,}\b",
            
        ),
        Pattern(
            name="aws_access_key",
            score=0.99,
            regex=r"\bAKIA[0-9A-Z]{16}\b",
            
        ),
        Pattern(
            name="generic_secret_float",
            score=0.7,
            regex=r"\b(?:api[_-]?key|apikey|secret|token)[\s:=]{1,3}[A-Za-z0-9\-_]{20,}\b",
            
        ),
    ]

    def __init__(self, supported_language: str = "en"):
        super().__init__(
            supported_entity="API_KEY",
            name="CustomApiKeyRecognizer",
            patterns=self.DEFAULT_PATTERNS,
            supported_language=supported_language,
            version="1.0.0",
            context=["api", "key", "secret", "token"],
        )


def _register_custom_recognizers(analyzer) -> None:
    """Add Aelvyril-specific recognizers to an already-initialised AnalyzerEngine.

    Recognizers are injected into both the engine's registry and its internal
    _recognizers list so they participate in analysis.
    """
    import logging

    logger = logging.getLogger("presidio-service")
    registry = analyzer.registry

    # Add our custom recognizers (they will be picked up by get_recognizers)
    api_key_rec = CustomApiKeyRecognizer()
    registry.add_recognizer(api_key_rec)
    logger.info("Registered CustomApiKeyRecognizer")

    phone_rec = CustomPhoneNumberRecognizer()
    registry.add_recognizer(phone_rec)
    logger.info("Registered CustomPhoneNumberRecognizer")

    org_rec = CustomSpacyOrganizationRecognizer()
    registry.add_recognizer(org_rec)
    logger.info("Registered CustomSpacyOrganizationRecognizer")




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