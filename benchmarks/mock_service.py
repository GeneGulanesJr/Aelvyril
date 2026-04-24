"""
Mock Aelvyril /analyze endpoint for benchmark pipeline validation.

Returns deterministic PII detections based on simple regex matching.
Does NOT require the actual Aelvyril service to be running.

Usage:
    python benchmarks/mock_service.py &
    python -m benchmarks.run --suite phase2
"""

from __future__ import annotations

import json
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict, List

# Simple regex-based PII detection for mock purposes
_PATTERNS = [
    (r"\b[A-Z][a-z]+ [A-Z][a-z]+\b", "PERSON"),
    (r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b", "EMAIL_ADDRESS"),
    (r"\b\d{3}-\d{2}-\d{4}\b", "US_SSN"),
    (r"\b\(\d{3}\) \d{3}-\d{4}\b", "PHONE_NUMBER"),
    (r"\b\d{3}-\d{3}-\d{4}\b", "PHONE_NUMBER"),
    (r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", "IP_ADDRESS"),
    (r"\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}\b", "CREDIT_CARD"),
    (r"\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}(?:[A-Z0-9]?){0,16}\b", "IBAN_CODE"),
]


def mock_detect(text: str) -> List[Dict[str, Any]]:
    """Return mock detections based on simple regex."""
    detections: List[Dict[str, Any]] = []
    seen = set()

    for pattern, entity_type in _PATTERNS:
        for match in re.finditer(pattern, text):
            key = (match.start(), match.end())
            if key in seen:
                continue
            seen.add(key)
            detections.append({
                "entity_type": entity_type,
                "start": match.start(),
                "end": match.end(),
                "text": match.group(),
                "score": 0.95,
            })

    return detections


class MockHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress request logs
        pass

    def _json_response(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_POST(self):
        if self.path == "/analyze":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                req = json.loads(body)
                text = req.get("text", "")
                detections = mock_detect(text)
                self._json_response(detections)
            except Exception as e:
                self._json_response({"error": str(e)}, 400)
        else:
            self._json_response({"error": "Not found"}, 404)

    def do_GET(self):
        if self.path == "/health":
            self._json_response({"presidio": True, "mock": True})
        else:
            self._json_response({"error": "Not found"}, 404)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
    server = HTTPServer(("", port), MockHandler)
    print(f"[Mock Aelvyril] Listening on http://localhost:{port}")
    print("  POST /analyze  — mock PII detection")
    print("  GET  /health   — health check")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[Mock Aelvyril] Shutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
