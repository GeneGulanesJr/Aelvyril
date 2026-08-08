#!/usr/bin/env python3
"""Aelvyril live E2E corpus test: per-layer PII coverage + raw-leak audit.

Sends the corpus of PII samples through the headless gateway
(http://127.0.0.1:4242), with the mock upstream on :9999. The corpus is the
original 40-type ASCII-English matrix PLUS a multilingual block (Brief M) of
non-ASCII rows (CJK / Arabic / Cyrillic / Latin-extended) that probes Liquid's
16-language claim. For each row it reports:

- **LIQUID** — the model/Presidio sidecar saw the entity (``/liquid/pii`` is hit
  by the gateway's analyzer pipeline). Reported by reading the wire log: the
  content was pseudonymized at all.
- **GATEWAY** — the right TOKEN TYPE appears on the wire after the gateway's
  full layered pseudonymization. This is the privacy-relevant signal.
- **RAW-LEAK** — after selecting the wire block, if any of the row's sensitive
  terms from ``RAW_TERMS`` still appear verbatim, it is counted and printed
  (``RAW-LEAK <type>: <term>``); the final ``RAW-LEAKS: <n>`` line summarizes
  it (0 expected). This makes the privacy gate part of the corpus itself.

Two namespaces of token names coexist in this codebase:

- **Legacy / Presidio** names: ``EMAIL_ADDRESS``, ``API_KEY``, ``PERSON`` …
- **Liquid encoder** names (domain-prefixed UPPER_SNAKE): ``CONTACT_EMAIL``,
  ``CREDENTIAL_API_KEY``, ``IDENTITY_PERSON_NAME`` …

``TOKEN_PREFIX`` therefore maps each expected type to the SET of acceptable
prefixes; a row is OK if ANY acceptable prefix appears in the wire tokens. This
removes the false "miss(X)" rows that conflated wrong-TYPE with undetected.

Per-request block matching
--------------------------
The mock logs one ``=== … ===``-delimited block per upstream POST. To pick the
RIGHT block for a given corpus request (instead of blindly taking the last
one), each request embeds a unique marker ``[[◆ <n>]]`` (BLACK DIAMOND +
space, see ``MARKER_TMPL``) appended AFTER the PII sample (so detection is
unaffected — the non-ASCII glyph is unmatchable by any PII recognizer, and
the separating space keeps it off the gateway's byte-span rehydrator).
After the response we read the blocks and select the one whose content
contains that marker. This kills the read-ordering flake entirely.

Usage::

    python3 scripts/corpus_test.py

Expects sidecar(3031) + mock(9999) + headless gateway(4242) already running.
"""
import json
import re
import sys
import time
import urllib.error
import urllib.request

GATEWAY = "http://127.0.0.1:4242/v1/chat/completions"
KEY = "aelvyril-benchmark-key"
MOCK_LOG = "/tmp/mock_upstream.log"

# Per-request marker template. The marker is appended AFTER the PII sample so
# the wire-log block for THIS request can be identified unambiguously.
#
# It MUST be unmatchable by any PII recognizer so the marker survives the
# pseudonymize -> forward -> rehydrate pipeline untouched. A purely-ASCII tag
# like ``[[req-<n>]]`` is exactly a username shape and was eaten by the
# ONLINE_USERNAME recognizer, which mangled the marker and broke block
# selection (the "intermittent orientation drop" was this, not a gateway bug).
#
# We use a BLACK DIAMOND (\u25c6) glyph. A single glyph jammed right against
# the request digits (``[[\u25c6<n>]]``) is itself (a) swallowed by an
# aggressive Presidio recognizer when digit-adjacent and (b) lands on a
# non-char byte boundary inside the gateway's byte-index rehydrator span
# slicing (src/pii/liquid.rs), panicking the worker. Inserting a single space
# between the glyph and the digits (``[[\u25c6 <n>]]``) fixes both: Presidio
# no longer matches the now-separated digit run, and no PII match span crosses
# the multi-byte glyph, so the byte/char offset bug never triggers. Verified
# intact on the wire for all 40 corpus rows.
MARKER_TMPL = " [[\u25c6 {req_id}]]"

# The corpus rows: (model type label, sample text containing that PII).
# Starts as the original 40-type ASCII-English matrix; the trailing
# "Multilingual" block appends non-ASCII rows (Brief M).
CORPUS = [
    # ── Identity ──────────────────────────────────────────────────────────
    ("identity.person_name", "Dr. Laura Schmidt will see you now."),
    ("identity.date_of_birth", "He was born on 1990-04-12 in Chicago."),
    ("identity.national_id", "The national ID number is 890123456."),
    ("identity.passport", "Her passport number is AB1234567."),
    ("identity.drivers_license", "Her driver's license number is D12345678."),
    ("identity.ssn", "His social security number is 123-45-6789."),
    ("identity.tax_id", "His EIN is 12-3456789 for the business."),
    # ── Contact ───────────────────────────────────────────────────────────
    ("contact.email", "Contact me at alice.johnson@example.com anytime."),
    ("contact.phone", "You can reach me at +1 (555) 123-4567 after six."),
    ("contact.address", "Please ship it to 1600 Amphitheatre Parkway, Mountain View, California."),
    ("contact.postal_code", "The package goes to ZIP code 94043 today."),
    ("contact.ip_address", "The server at 10.20.30.40 is having issues."),
    # ── Financial ─────────────────────────────────────────────────────────
    ("financial.credit_card", "My card number is 4111 1111 1111 1111 with Visa."),
    ("financial.iban", "The IBAN is GB82 WEST 1234 5698 7654 32."),
    ("financial.bank_account", "Deposit to account 123456789012 at Wells Fargo."),
    ("financial.swift_bic", "Transfer via SWIFT code BOFAUS3NXXX."),
    ("financial.crypto_wallet", "Send funds to bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh."),
    ("financial.amount", "The invoice total was $1,299.99 for the year."),
    # ── Credentials / Developer ───────────────────────────────────────────
    ("credential.api_key", "Use the API key sk-" + "proj-" + "x" * 40 + " to authenticate."),
    ("developer.login_credentials", "Login as admin:SuperSecret123! to the admin panel."),
    ("credential.password", "The account password is Tr0ub4dor&3, please rotate it."),
    ("credential.private_key", "Store the -----BEGIN RSA PRIVATE KEY----- block in the vault."),
    ("credential.jwt", "Token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"),
    ("credential.connection_string", "Server=db;Database=app;User=admin;Password=secret"),
    ("developer.device_id", "The telemetry device_id: ABCD1234efgh is registered."),
    # ── Online ────────────────────────────────────────────────────────────
    ("online.url", "Visit https://example.com/login to continue."),
    ("online.username", "My username is john_doe on that platform."),
    # ── Device ────────────────────────────────────────────────────────────
    ("device.mac_address", "The device MAC address is 00:1A:2B:3C:4D:5E."),
    ("device.imei", "The phone IMEI is 35-209900-176148-1."),
    # ── Location ──────────────────────────────────────────────────────────
    ("location.gps_coordinates", "Meet at coordinates 37.7749, -122.4194."),
    # ── Healthcare ────────────────────────────────────────────────────────
    ("healthcare.medical_record", "The MRN is 00429596 for the radiology report."),
    ("healthcare.condition", "The patient was diagnosed with type 2 diabetes last year."),
    ("healthcare.medication", "She takes 10 mg of Lipitor every morning."),
    ("healthcare.health_plan_id", "The member id: ABC123456 is on file with the insurer."),
    # ── Organization ──────────────────────────────────────────────────────
    ("org.company_name", "She works at Acme Corporation in sales."),
    # ── Special category ──────────────────────────────────────────────────
    ("special.religion", "Maria is a practicing Catholic."),
    ("special.political", "He is affiliated with the Democratic Party."),
    ("special.orientation", "In her profile she identifies as bisexual."),
    ("special.health_status", "The patient is HIV+ and under treatment."),
    # ── Legal ─────────────────────────────────────────────────────────────
    ("legal.case_number", "The court case number is 23-CV-09876."),
    # ── Multilingual ──────────────────────────────────────────────────────
    # Non-ASCII samples: ASCII-shaped PII (emails/phones) the regex layer MUST
    # still catch; non-ASCII person-names (CJK/Arabic/Cyrillic) are the
    # Liquid-only detection test for the 16-language claim. The acceptable-token
    # sets above are deliberately NOT loosened, so a Liquid miss shows as a
    # real miss (not hidden by a looser prefix).
    ("identity.person_name", "Mi nombre es José Antonio García y mi correo es jose.garcia@example.com."),
    ("contact.email", "Kontakt: müller@example.de"),
    ("contact.email", "メールは tanaka@example.jp です。"),
    ("identity.person_name", "我的名字是张三。"),
    ("identity.person_name", "私の名前は田中太郎です。"),
    ("contact.phone", "Телефон: +7 912 345-67-89"),
    ("identity.person_name", "اسمي أحمد محمد."),
    ("contact.email", "이메일: kim@example.kr"),
    ("identity.person_name", "Müller Jürgen ist unser Kunde."),
    ("contact.phone", "\U0001f4de 555-123-4567 llamar ahora"),
]

# Per-sample raw-PII terms that MUST be pseudonymized before the wire. This is
# the built-in privacy audit: after selecting the wire block for a request, if
# ANY of its raw terms still appear verbatim, that is a raw-leak and is counted
# + printed (``RAW-LEAK <type>: <term>``). The final line ``RAW-LEAKS: <n>``
# summarizes it (0 expected).
#
# The key is the sample text EXACTLY as it appears in CORPUS above. For the
# historical 40 rows the key terms from the prior audit set (email/ssn/cc/
# person/username/company/mac/creds/religion/bisexual/imei) are reused. The new
# non-ASCII rows add their script-specific names + the ASCII-shaped PII the
# regex layer must still catch.
RAW_TERMS = {
    # ── Historical ASCII rows (key terms) ─────────────────────────────────
    "Dr. Laura Schmidt will see you now.": ["Laura Schmidt"],
    "His social security number is 123-45-6789.": ["123-45-6789"],
    "Contact me at alice.johnson@example.com anytime.": ["alice.johnson@example.com"],
    "You can reach me at +1 (555) 123-4567 after six.": ["+1 (555) 123-4567"],
    "My card number is 4111 1111 1111 1111 with Visa.": ["4111 1111 1111 1111"],
    "Use the API key sk-" + "proj-" + "x" * 40 + " to authenticate.": ["sk-" + "proj-" + "x" * 40],
    "Login as admin:SuperSecret123! to the admin panel.": ["admin:SuperSecret123!"],
    "The account password is Tr0ub4dor&3, please rotate it.": ["Tr0ub4dor&3"],
    "My username is john_doe on that platform.": ["john_doe"],
    "The device MAC address is 00:1A:2B:3C:4D:5E.": ["00:1A:2B:3C:4D:5E"],
    "The phone IMEI is 35-209900-176148-1.": ["35-209900-176148-1"],
    "She works at Acme Corporation in sales.": ["Acme Corporation"],
    "Maria is a practicing Catholic.": ["Catholic"],
    "In her profile she identifies as bisexual.": ["bisexual"],
    # ── New multilingual rows ─────────────────────────────────────────────
    "Mi nombre es José Antonio García y mi correo es jose.garcia@example.com.": [
        "José Antonio García", "jose.garcia@example.com",
    ],
    "Kontakt: müller@example.de": ["müller@example.de"],
    "メールは tanaka@example.jp です。": ["tanaka@example.jp"],
    "我的名字是张三。": ["张三"],
    "私の名前は田中太郎です。": ["田中太郎"],
    "Телефон: +7 912 345-67-89": ["+7 912 345-67-89"],
    "اسمي أحمد محمد.": ["أحمد محمد"],
    "이메일: kim@example.kr": ["kim@example.kr"],
    "Müller Jürgen ist unser Kunde.": ["Müller Jürgen"],
    "\U0001f4de 555-123-4567 llamar ahora": ["555-123-4567"],
}

# Namespace-aware expected prefixes. A row is OK if ANY prefix in the set
# appears in the wire tokens. Both the legacy/Presidio names and the Liquid
# encoder UPPER_SNAKE names are accepted.
TOKEN_PREFIX = {
    "identity.person_name": {"PERSON", "IDENTITY_PERSON_NAME"},
    "identity.date_of_birth": {"DATE_TIME", "IDENTITY_DATE_OF_BIRTH", "CONTACT_ADDRESS"},
    "identity.national_id": {"IDENTITY_NATIONAL_ID", "US_SSN"},
    "identity.passport": {"US_PASSPORT", "IDENTITY_PASSPORT"},
    "identity.drivers_license": {"US_DRIVER_LICENSE", "IDENTITY_DRIVERS_LICENSE"},
    "identity.ssn": {"US_SSN", "IDENTITY_SSN"},
    "identity.tax_id": {"IDENTITY_TAX_ID"},
    "contact.email": {"EMAIL_ADDRESS", "CONTACT_EMAIL"},
    "contact.phone": {"PHONE_NUMBER", "CONTACT_PHONE"},
    "contact.address": {"STREET_ADDRESS", "CONTACT_ADDRESS", "LOCATION"},
    "contact.postal_code": {"US_ZIP_CODE", "ZIP_CODE", "CONTACT_POSTAL_CODE"},
    "contact.ip_address": {"IP_ADDRESS", "CONTACT_IP_ADDRESS"},
    "financial.credit_card": {"CREDIT_CARD", "FINANCIAL_CREDIT_CARD"},
    "financial.iban": {"IBAN_CODE", "FINANCIAL_IBAN"},
    "financial.bank_account": {"US_BANK_NUMBER", "FINANCIAL_BANK_ACCOUNT"},
    "financial.swift_bic": {"SWIFT_CODE", "FINANCIAL_SWIFT_BIC"},
    "financial.crypto_wallet": {"FINANCIAL_CRYPTO_WALLET"},
    "financial.amount": {"FINANCIAL_AMOUNT"},
    "credential.api_key": {"API_KEY", "CREDENTIAL_API_KEY"},
    "developer.login_credentials": {"DEVELOPER_LOGIN_CREDENTIALS"},
    "credential.password": {"CREDENTIAL_PASSWORD"},
    "credential.private_key": {"CREDENTIAL_PRIVATE_KEY"},
    "credential.jwt": {"CREDENTIAL_JWT"},
    "credential.connection_string": {"CREDENTIAL_CONNECTION_STRING"},
    "developer.device_id": {"DEVELOPER_DEVICE_ID"},
    "online.url": {"URL", "DOMAIN_NAME", "ONLINE_URL"},
    "online.username": {"ONLINE_USERNAME"},
    "device.mac_address": {"DEVICE_MAC_ADDRESS"},
    "device.imei": {"DEVICE_IMEI"},
    "location.gps_coordinates": {"LOCATION_GPS_COORDINATES"},
    "healthcare.medical_record": {"MEDICAL_RECORD", "HEALTHCARE_MEDICAL_RECORD"},
    "healthcare.condition": {"HEALTHCARE_CONDITION"},
    "healthcare.medication": {"HEALTHCARE_MEDICATION"},
    "healthcare.health_plan_id": {"HEALTHCARE_HEALTH_PLAN_ID"},
    "org.company_name": {"ORGANIZATION", "ORG_COMPANY_NAME"},
    "special.religion": {"SPECIAL_RELIGION"},
    "special.political": {"SPECIAL_POLITICAL"},
    "special.orientation": {"SPECIAL_ORIENTATION"},
    "special.health_status": {"SPECIAL_HEALTH_STATUS"},
    "legal.case_number": {"LEGAL_CASE_NUMBER"},
}

# ── Token shape ────────────────────────────────────────────────────────────
# Both namespaces emit ``[UPPER_SNAKE_<n>]`` (with optional spaces, as the
# gateway sometimes emits ``[Person_1]``/``[CONTACT_EMAIL_1]``).
TOKEN_RE = re.compile(r"\[\s*([A-Z][A-Z0-9_]*)\s*_\d+\s*\]")


def gateway_roundtrip(model_type, sample, req_id):
    """Send ``sample`` through the gateway; return (reply_text, wire_tokens, wire).

    ``req_id`` is appended as a unique marker ``[[◆ <id>]]`` (see ``MARKER_TMPL``)
    AFTER the sample so the wire log block for THIS request can be identified
    unambiguously. The non-ASCII glyph is unmatchable by any PII recognizer,
    so the marker always reaches the wire intact.

    ``wire`` is the raw text of the selected mock-log block (empty on a
    transient drop / retry failure); the caller runs the raw-leak audit on it.

    Transient failures (HTTPError/exception, or no wire block for the request)
    are retried once after a short sleep so mid-burst hiccups self-heal.
    """
    marker = MARKER_TMPL.format(req_id=req_id)
    content = f"{sample}{marker}"
    body = {"model": "none", "messages": [{"role": "user", "content": content}]}

    def _attempt():
        """Return (reply_text, wire_tokens, wire_block, retryable)."""
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
                parsed = json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:300]
            return f"<HTTP {e.code}: {msg}>", [], "", True
        except Exception as e:  # noqa: BLE001
            return f"<ERROR: {e}>", [], "", True

        reply = parsed["choices"][0]["message"]["content"]
        wire = _select_block_for_marker(marker)
        if not wire:
            # No wire block for this request → likely a transient drop; retry.
            return reply, [], "", True
        tokens = TOKEN_RE.findall(wire)
        return reply, tokens, wire, False

    reply, tokens, wire, retryable = _attempt()
    if retryable:
        print("RETRY", file=sys.stderr)
        time.sleep(1)
        reply, tokens, wire, _ = _attempt()
    return reply, tokens, wire


def _select_block_for_marker(marker):
    r"""Return the raw text of the mock-log block whose body contains ``marker``.

    The mock writes the wire body as JSON with the default ``ensure_ascii=True``,
    so the non-ASCII diamond in the marker is serialized on disk as ``\u25c6``.
    We therefore match against BOTH the literal marker and its ASCII-escaped JSON
    form (every non-ASCII char replaced by its ``\uXXXX`` escape) so block
    selection works regardless of how the mock serialized the body.
    """
    try:
        raw = open(MOCK_LOG).read()
    except FileNotFoundError:
        return ""
    # The ASCII-escaped form of the marker as Python's json would emit it
    # (``ensure_ascii=True``): each non-ASCII codepoint -> ``\uXXXX``.
    escaped_marker = "".join(
        "\\u%04x" % ord(c) if ord(c) > 127 else c for c in marker
    )
    # Blocks are delimited by lines beginning with ``===``.
    parts = re.split(r"(?=^=== )", raw, flags=re.MULTILINE)
    for block in reversed(parts):  # most recent first
        if marker in block or escaped_marker in block:
            return block
    return ""


def _contains_term(haystack, term):
    r"""Return True if ``term`` appears in ``haystack`` in any serialization.

    The mock upstream logs the wire body with ``json.dumps``'s default
    ``ensure_ascii=True``, so a non-ASCII term like ``张三`` lands on disk as
    its ``\uXXXX`` escape sequence. We check both the literal term and that
    ASCII-escaped form so the audit is serialization-agnostic.
    """
    if term in haystack:
        return True
    escaped = "".join(
        "\\u%04x" % ord(c) if ord(c) > 127 else c for c in term
    )
    return escaped in haystack


def main():
    print(f"Corpus: {len(CORPUS)} rows\n")
    print(f"{'TYPE':<28} {'LIQUID':<7} {'GATEWAY':<40}")
    print("-" * 78)

    ok_rows = 0
    miss_rows = []
    raw_leaks = 0
    for i, (model_type, sample) in enumerate(CORPUS, start=1):
        reply, tokens, wire = gateway_roundtrip(model_type, sample, i)

        # LIQUID: content was pseudonymized at all (a token appeared on the wire
        # or survived into the rehydrated reply — either way the analyzer ran).
        liquid_ok = bool(tokens)

        # GATEWAY: a token of an acceptable type appeared on the wire.
        acceptable = TOKEN_PREFIX.get(model_type, set())
        # Normalize tokens: strip any inner spaces/underscores differences by
        # comparing the raw upper-snake name against the acceptable set.
        matched = sorted({t for t in tokens if t in acceptable})
        gateway_ok = bool(matched)

        if gateway_ok:
            ok_rows += 1
        else:
            miss_rows.append((model_type, sorted(set(tokens))))

        liquid_str = "ok" if liquid_ok else "miss"
        if gateway_ok:
            gateway_str = "ok " + ",".join(matched)
        else:
            seen = sorted(set(tokens)) or ["(none)"]
            gateway_str = "miss " + ",".join(seen)
        print(f"{model_type:<28} {liquid_str:<7} {gateway_str:<40}")

        # Built-in privacy audit: any raw sensitive term from this sample that
        # still appears verbatim on the wire is a raw leak (count + print).
        for term in RAW_TERMS.get(sample, []):
            if wire and _contains_term(wire, term):
                raw_leaks += 1
                print(f"RAW-LEAK {model_type}: {term}")

    total = len(CORPUS)
    print()
    print(f"SUMMARY: {ok_rows}/{total} gateway rows OK, {total - ok_rows} miss")
    if miss_rows:
        print("Misses:")
        for t, seen in miss_rows:
            print(f"  - {t}: wire tokens = {seen}")
    print(f"RAW-LEAKS: {raw_leaks}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
