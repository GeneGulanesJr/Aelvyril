#!/usr/bin/env python3
"""Mock OpenAI-compatible upstream for Aelvyril live E2E test.

Sits where the real provider would (default :9999) and:
- Logs the FULL request body it receives to a log path (default
  ``/tmp/mock_upstream.log``). This is the **wire evidence**: it must contain
  pseudonymized TOKENS, not original PII.
- Responds with a chat completion that ECHOES the user message content back,
  simulating an LLM that repeats the (pseudonymized) user text. The gateway
  rehydrates the response, so the client sees the ORIGINAL values.

Usage::

    python3 scripts/mock_upstream.py [PORT] [LOG_PATH]

Both arguments are optional; defaults are port ``9999`` and
``/tmp/mock_upstream.log``.

Body reading
------------
The gateway (reqwest) sends the first attempt of a forwarded request with
``Transfer-Encoding: chunked`` and no ``Content-Length``. The previous version of
this mock only read ``Content-Length`` and therefore read an empty body for the
chunked attempt — it logged an empty block and returned 200, which made the
gateway retry with the real body. That produced two logged blocks per forward
and broke the corpus harness (the "last block" read could grab the wrong
request). This mock now understands chunked transfer-encoding and falls back to
``Content-Length`` when present, so each forward yields exactly ONE logged block.
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _read_body_chunked(rfile):
    """Read an HTTP/1.1 chunked body from ``rfile``.

    Each chunk is ``<hex size>\\r\\n<body>\\r\\n``; the body ends with a ``0``-size
    chunk followed by a trailing ``\\r\\n`` (and any trailers, which we discard).
    Returns the concatenated bytes.
    """
    chunks = []
    while True:
        size_line = rfile.readline()
        if not size_line:
            break
        # chunk size line may contain chunk extensions after ``;``
        size_str = size_line.split(b";", 1)[0].strip()
        try:
            size = int(size_str, 16)
        except ValueError:
            # Malformed size line — stop to avoid an infinite loop.
            break
        if size == 0:
            # Consume trailing CRLF (and any trailers up to the final blank line).
            while True:
                trailer = rfile.readline()
                if trailer in (b"\r\n", b"\n", b""):
                    break
            break
        data = rfile.read(size)
        chunks.append(data)
        # Consume the CRLF that follows the chunk data.
        rfile.read(2)
    return b"".join(chunks)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # silence default stderr logging
        pass

    def _read_request_body(self):
        """Read the full request body whether chunked or Content-Length encoded."""
        te = self.headers.get("Transfer-Encoding", "")
        if te and "chunked" in te.lower():
            return _read_body_chunked(self.rfile)
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length > 0:
            return self.rfile.read(length)
        return b""

    def do_POST(self):
        body = self._read_request_body()
        try:
            req = json.loads(body) if body else {}
        except Exception:
            req = {"raw": body.decode("utf-8", "replace")}

        with open(self.server.log_path, "a") as f:
            f.write(f"=== {time.strftime('%H:%M:%S')} POST {self.path} ===\n")
            f.write(json.dumps(req, indent=2) + "\n")

        # Echo the last user message content back as the assistant reply.
        content = ""
        for msg in req.get("messages", []):
            if msg.get("role") == "user":
                content = msg.get("content", "")
        resp = {
            "id": "chatcmpl-mock123",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": req.get("model", "none"),
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
        }
        data = json.dumps(resp).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        data = json.dumps({"status": "ok", "path": self.path}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class _LoggingServer(ThreadingHTTPServer):
    """ThreadingHTTPServer that carries the log path so the handler can find it."""
    log_path = "/tmp/mock_upstream.log"


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9999
    log_path = sys.argv[2] if len(sys.argv) > 2 else "/tmp/mock_upstream.log"
    # Start each run from a clean log so block-counting is unambiguous.
    try:
        open(log_path, "w").close()
    except OSError:
        pass
    srv = _LoggingServer(("127.0.0.1", port), Handler)
    srv.log_path = log_path
    print(
        f"[mock-upstream] listening on 127.0.0.1:{port}, logging to {log_path}",
        flush=True,
    )
    srv.serve_forever()
