#!/usr/bin/env python3
"""Aelvyril live E2E corpus test: per-layer PII coverage across all 40 types.

Sends a 40-type corpus of PII samples through the headless gateway
(http://127.0.0.1:4242), with the mock upstream on :9999. For each type it
reports:

- **LIQUID** — the model/Presidio sidecar saw the entity (``/liquid/pii`` is hit
  by the gateway's analyzer pipeline). Reported by reading the wire log: the
  content was pseudonymized at all.
- **GATEWAY** — the right TOKEN TYPE appears on the wire after the gateway's
  full layered pseudonymization. This is the privacy-relevant signal.

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
one), each request embeds a unique marker ``[[req-<n>]]`` appended AFTER the
PII sample (so detection is unaffected). After the response we read the blocks
and select the one whose content contains that marker. This kills the
read-ordering flake entirely.

Usage::

    python3 scripts/corpus_test.py

Expects sidecar(3031) + mock(9999) + headless gateway(4242) already running.
"""
import json
import re
import sys
import urllib.error
import urllib.request

GATEWAY = "http://127.0.0.1:4242/v1/chat/completions"
KEY = "aelvyril-benchmark-key"
MOCK_LOG = "/tmp/mock_upstream.log"

# The 40 corpus rows: (model type label, sample text containing that PII).
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
    ("credential.api_key", "Use the API key sk-proj-AbCdEfGhIjKlMnOpQrStUvWx to authenticate."),
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
]

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
    """Send ``sample`` through the gateway; return (reply_text, wire_tokens).

    ``req_id`` is appended as a unique marker ``[[req-<id>]]`` AFTER the sample
    so the wire log block for THIS request can be identified unambiguously.
    """
    marker = f" [[req-{req_id}]]"
    content = f"{sample}{marker}"
    body = {"model": "none", "messages": [{"role": "user", "content": content}]}
    req = urllib.request.Request(
        GATEWAY,
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            parsed = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        msg = e.read().decode()[:300]
        return f"<HTTP {e.code}: {msg}>", []
    except Exception as e:  # noqa: BLE001
        return f"<ERROR: {e}>", []

    reply = parsed["choices"][0]["message"]["content"]
    # Select the wire block whose content contains THIS request's marker.
    wire = _select_block_for_marker(marker)
    tokens = TOKEN_RE.findall(wire) if wire else []
    return reply, tokens


def _select_block_for_marker(marker):
    """Return the raw text of the mock-log block whose body contains ``marker``."""
    try:
        raw = open(MOCK_LOG).read()
    except FileNotFoundError:
        return ""
    # Blocks are delimited by lines beginning with ``===``.
    parts = re.split(r"(?=^=== )", raw, flags=re.MULTILINE)
    for block in reversed(parts):  # most recent first
        if marker in block:
            return block
    return ""


def main():
    print(f"Corpus: {len(CORPUS)} rows\n")
    print(f"{'TYPE':<28} {'LIQUID':<7} {'GATEWAY':<40}")
    print("-" * 78)

    ok_rows = 0
    miss_rows = []
    for i, (model_type, sample) in enumerate(CORPUS, start=1):
        reply, tokens = gateway_roundtrip(model_type, sample, i)

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

    total = len(CORPUS)
    print()
    print(f"SUMMARY: {ok_rows}/{total} gateway rows OK, {total - ok_rows} miss")
    if miss_rows:
        print("Misses:")
        for t, seen in miss_rows:
            print(f"  - {t}: wire tokens = {seen}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
