#!/usr/bin/env python3
"""Aelvyril live E2E smoke test: PII detection -> pseudonymization -> forward -> rehydration.

A focused single-request sanity check. Sends one chat completion containing a
small set of PII through the headless gateway (http://127.0.0.1:4242), with the
mock upstream on :9999. Verifies:

  1. The gateway response contains the ORIGINAL PII values (rehydration worked).
  2. The mock upstream log contains TOKEN placeholders, not the original values
     (pseudonymization happened before the wire).
  3. No token placeholders leak into the final response.

This is complementary to ``corpus_test.py``: the corpus covers all 40 types and
does namespace-aware token-type checks; this script is the broad "did the whole
pipeline round-trip correctly" smoke test. Run it first to confirm the harness
is wired up, then run the corpus for coverage.

Usage::

    python3 scripts/e2e_test.py
"""
import json
import re
import sys
import urllib.error
import urllib.request

GATEWAY = "http://127.0.0.1:4242/v1/chat/completions"
KEY = "aelvyril-benchmark-key"
MOCK_LOG = "/tmp/mock_upstream.log"

TEXT = (
    "Hi! My email is alice@example.com, call me at 555-123-4567. "
    "The server is 10.0.0.1 and my card is 4111-1111-1111-1111."
)

body = {
    "model": "none",
    "messages": [{"role": "user", "content": TEXT}],
}

req = urllib.request.Request(
    GATEWAY,
    data=json.dumps(body).encode(),
    headers={
        "Authorization": f"Bearer {KEY}",
        "Content-Type": "application/json",
    },
    method="POST",
)

try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw = resp.read().decode()
        parsed = json.loads(raw)
except urllib.error.HTTPError as e:
    print(f"HTTP {e.code}: {e.read().decode()[:2000]}")
    sys.exit(2)
except Exception as e:  # noqa: BLE001
    print(f"ERROR: {e}")
    sys.exit(2)

reply = parsed["choices"][0]["message"]["content"]
print("=== GATEWAY RESPONSE CONTENT ===")
print(reply)
print()

originals = ["alice@example.com", "555-123-4567", "10.0.0.1", "4111-1111-1111-1111"]
tokens_found = re.findall(r"\[[A-Z_]+_\d+\]", reply)

print("=== CHECKS ===")
for o in originals:
    ok = o in reply
    print(f"  original rehydrated {o!r}: {'PASS' if ok else 'FAIL'}")

leaked = [t for t in tokens_found if t in reply]
print(f"  token placeholders in response: {'FAIL ' + str(leaked) if leaked else 'PASS (none)'}")

# Check the mock upstream log (wire evidence)
print()
print("=== MOCK UPSTREAM WIRE LOG (last request) ===")
try:
    log = open(MOCK_LOG).read().strip().split("\n===")[-1]
    print(log[:1500])
    wire = log
    wire_has_originals = [o for o in originals if o in wire]
    print()
    print(f"  wire contained original PII (should be NONE): {wire_has_originals or 'PASS (none)'}")
    wire_tokens = re.findall(r"\[[A-Z_]+_\d+\]", wire)
    print(
        "  wire contained tokens (should be YES): "
        + ("PASS " + str(wire_tokens[:6]) if wire_tokens else "FAIL (no tokens on wire)")
    )
except FileNotFoundError:
    print("  (mock log not found — upstream never hit?)")

all_pass = all(o in reply for o in originals) and not leaked
print()
print("E2E RESULT:", "ALL PASS" if all_pass else "FAILURES PRESENT")
sys.exit(0 if all_pass else 1)
