"""
NVIDIA Nemotron-PII dataset downloader and loader.

Downloads the Nemotron-PII test split from HuggingFace, validates integrity,
and provides a unified loading interface.

Nemotron-PII contains 50,000 test samples with span-level annotations for
55 PII/PHI entity types, generated with NVIDIA NeMo Data Designer using
synthetic personas grounded in U.S. Census data.

Source: https://huggingface.co/datasets/nvidia/Nemotron-PII
License: CC BY 4.0
Paper: NVIDIA NeMo Data Designer (2025)

Dataset format (per sample):
    {
        "uid": str,                        # UUID
        "domain": str,                     # Industry domain
        "document_type": str,              # e.g., "visa application", "invoice"
        "document_description": str,       # Description of the document
        "document_format": str,            # "structured" | "unstructured"
        "locale": str,                     # "us" | "intl"
        "text": str,                       # The full text containing PII
        "spans": [                         # Ground-truth PII annotations
            {
                "start": int,             # Character offset start
                "end": int,               # Character offset end
                "text": str,              # The PII text
                "label": str              # e.g., "first_name", "ssn"
            }
        ],
        "text_tagged": str                 # Inline tagged version
    }
"""

from __future__ import annotations

import ast
import hashlib
import json
import os
import urllib.request
from typing import Dict, List, Optional

# Nemotron-PII dataset source (HuggingFace)
NEMOTRON_PII_URL = (
    "https://huggingface.co/datasets/nvidia/Nemotron-PII/"
    "resolve/main/data/test-00000-of-00001.parquet"
)

# Known SHA256 of the test parquet (for integrity verification)
NEMOTRON_PII_TEST_SHA256 = None  # Populated on first verified download

# Nemotron-PII entity label → Presidio entity type mapping
#
# Design principles:
#   1. One-to-one: each Nemotron label maps to exactly one Presidio type.
#   2. No collapsing: CITY stays CITY, STREET_ADDRESS stays STREET_ADDRESS.
#      Different concepts are never merged into the same bucket.
#   3. Presidio namespace: all types are Presidio entity types, which is
#      what the Aelvyril gateway outputs. Both sides of the comparison
#      use the same namespace for direct string matching.
#   4. Best-effort: some Nemotron types have no exact Presidio equivalent.
#      These are mapped to the closest standard type with a comment.
#
# For display names (reports), use DISPLAY_NAMES in aelvyril_evaluator.py.

NEMOTRON_ENTITY_MAP: Dict[str, str] = {
    # ── Person identifiers ────────────────────────────────────────────────
    "first_name": "PERSON",
    "last_name": "PERSON",
    "user_name": "PERSON",

    # ── Contact info ──────────────────────────────────────────────────────
    "email": "EMAIL_ADDRESS",
    "phone_number": "PHONE_NUMBER",
    "fax_number": "PHONE_NUMBER",

    # ── Government/legal IDs ──────────────────────────────────────────────
    "ssn": "US_SSN",
    "national_id": "US_SSN",              # best-effort: country-agnostic → US_SSN
    "passport_number": "US_PASSPORT",     # not a standard Presidio type but granular
    "license_plate": "US_DRIVER_LICENSE",
    "certificate_license_number": "US_DRIVER_LICENSE",
    "tax_id": "US_SSN",                  # best-effort

    # ── Financial ─────────────────────────────────────────────────────────
    "credit_debit_card": "CREDIT_CARD",
    "cvv": "CREDIT_CARD",                # CVV is a card sub-field
    "bank_routing_number": "US_BANK_NUMBER",
    "account_number": "US_BANK_NUMBER",
    "swift_bic": "SWIFT_CODE",
    "pin": "US_BANK_NUMBER",

    # ── Location (fine-grained — no collapsing) ───────────────────────────
    "street_address": "STREET_ADDRESS",
    "city": "CITY",
    "state": "US_STATE",
    "country": "COUNTRY",                # not standard Presidio but semantically distinct
    "county": "LOCATION",                # no specific Presidio type
    "postcode": "US_ZIP_CODE",
    "coordinate": "LOCATION",             # GPS coordinates

    # ── Medical/health ────────────────────────────────────────────────────
    "medical_record_number": "MEDICAL_RECORD",
    "health_plan_beneficiary_number": "MEDICAL_RECORD",
    "blood_type": "MEDICAL_RECORD",
    "biometric_identifier": "MEDICAL_RECORD",

    # ── Dates/times ───────────────────────────────────────────────────────
    "date": "DATE_TIME",
    "date_of_birth": "DATE_TIME",
    "date_time": "DATE_TIME",
    "time": "DATE_TIME",
    "age": "AGE",

    # ── Digital/technical ─────────────────────────────────────────────────
    "ipv4": "IP_ADDRESS",
    "ipv6": "IP_ADDRESS",
    "url": "URL",
    "domain": "URL",               # matches PiiType::Domain → Display("URL")
    "mac_address": "IP_ADDRESS",          # best-effort: network identifier
    "api_key": "API_KEY",
    "http_cookie": "API_KEY",             # best-effort: credential-like
    "password": "API_KEY",                # best-effort: credential-like
    "device_identifier": "ID",
    "unique_id": "ID",
    "customer_id": "ID",
    "employee_id": "ID",

    # ── Organization ──────────────────────────────────────────────────────
    "company_name": "ORGANIZATION",

    # ── Demographics ──────────────────────────────────────────────────────
    "gender": "NRP",
    "race_ethnicity": "NRP",
    "religious_belief": "NRP",
    "political_view": "NRP",
    "sexuality": "NRP",
    "occupation": "TITLE",
    "education_level": "TITLE",
    "employment_status": "TITLE",
    "language": "NATIONALITY",

    # ── Other ─────────────────────────────────────────────────────────────
    "vehicle_identifier": "ID",
}

# Labels that have no meaningful Presidio/Aelvyril equivalent and are
# excluded from evaluation.
#
# NRP (Not Relevant PII): demographic attributes that are not personally
# identifying information — gender, race, religion, politics, sexuality.
# These are semantic attributes about a person, not PII that needs
# redaction. Including them as gold ORGANIZATION (the old bug) inflated
# that entity’s totals by 33k spans (3.9% of Nemotron gold).
NON_PII_DEMOGRAPHIC_LABELS: set = {
    "gender",
    "race_ethnicity",
    "religious_belief",
    "political_view",
    "sexuality",
}

EXCLUDED_LABELS: set = NON_PII_DEMOGRAPHIC_LABELS | set()


def get_data_dir(output_dir: str = "benchmarks/data/nemotron-pii") -> str:
    """Get or create the data directory for Nemotron-PII."""
    os.makedirs(output_dir, exist_ok=True)
    return output_dir


def download_nemotron_pii(
    output_dir: str = "benchmarks/data/nemotron-pii",
    force: bool = False,
) -> str:
    """Download Nemotron-PII test split from HuggingFace.

    Downloads the test parquet file (50,000 samples). Conversion to JSON
    happens at load time to keep the download small and verifiable.

    Args:
        output_dir: Directory to store downloaded data.
        force: Re-download even if data already exists.

    Returns:
        Path to the data directory.

    Raises:
        RuntimeError: If download fails.
    """
    data_dir = get_data_dir(output_dir)
    manifest_path = os.path.join(data_dir, "download_manifest.json")
    parquet_path = os.path.join(data_dir, "test.parquet")

    # Check if already downloaded
    if not force and os.path.exists(manifest_path):
        with open(manifest_path) as f:
            manifest = json.load(f)
        if manifest.get("status") == "complete" and os.path.exists(parquet_path):
            print(f"[OK] Nemotron-PII dataset already downloaded at {data_dir}")
            return data_dir

    print(f"[INFO] Downloading Nemotron-PII test split to {data_dir}...")

    try:
        urllib.request.urlretrieve(NEMOTRON_PII_URL, parquet_path)
    except Exception as e:
        raise RuntimeError(
            f"Failed to download Nemotron-PII dataset: {e}\n\n"
            f"Manual fallback:\n"
            f"  1. Download {NEMOTRON_PII_URL}\n"
            f"  2. Place the file at {parquet_path}\n"
            f"  3. Re-run the benchmark."
        ) from e

    # Verify download is valid parquet
    try:
        import pyarrow.parquet as pq
        table = pq.read_table(parquet_path)
        num_rows = table.num_rows
    except Exception as e:
        # Remove corrupt file
        if os.path.exists(parquet_path):
            os.remove(parquet_path)
        raise RuntimeError(
            f"Downloaded file is not valid Parquet: {e}"
        ) from e

    # Compute SHA256
    sha256 = _compute_file_hash(parquet_path)

    # Write manifest
    manifest = {
        "status": "complete",
        "source": "NVIDIA Nemotron-PII (HuggingFace, CC BY 4.0)",
        "url": NEMOTRON_PII_URL,
        "total_samples": num_rows,
        "parquet_file": "test.parquet",
        "sha256": sha256,
        "data_source": "real",
    }
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"[OK] Nemotron-PII test split ready: {num_rows:,} samples in {data_dir}")
    return data_dir


def load_nemotron_pii(
    data_dir: str = "benchmarks/data/nemotron-pii",
    splits: Optional[List[str]] = None,
    max_samples: Optional[int] = None,
    domains: Optional[List[str]] = None,
    document_formats: Optional[List[str]] = None,
) -> List[dict]:
    """Load Nemotron-PII test split from disk.

    Reads the Parquet file, parses spans from Python-literal strings,
    and returns a list of normalized sample dicts.

    Args:
        data_dir: Directory containing downloaded data.
        splits: Ignored (Nemotron-PII has no sub-splits). Kept for API compat.
        max_samples: Limit number of samples loaded (None = all 50,000).
        domains: Filter by domain (e.g., ["Healthcare Providers", "Banking"]).
        document_formats: Filter by format ("structured", "unstructured").

    Returns:
        List of sample dicts with ground-truth annotations.
    """
    import pyarrow.parquet as pq

    parquet_path = os.path.join(data_dir, "test.parquet")
    if not os.path.exists(parquet_path):
        raise FileNotFoundError(
            f"Nemotron-PII dataset not found at {parquet_path}. "
            "Run download_nemotron_pii() first."
        )

    table = pq.read_table(parquet_path)
    total = table.num_rows

    # Apply max_samples limit
    if max_samples and max_samples < total:
        table = table.slice(0, max_samples)

    samples: List[dict] = []
    for i in range(table.num_rows):
        domain = table.column("domain")[i].as_py()
        doc_format = table.column("document_format")[i].as_py()

        # Apply filters
        if domains and domain not in domains:
            continue
        if document_formats and doc_format not in document_formats:
            continue

        # Parse spans from Python-literal string
        spans_raw = table.column("spans")[i].as_py()
        try:
            spans = ast.literal_eval(spans_raw) if isinstance(spans_raw, str) else spans_raw
        except (ValueError, SyntaxError):
            spans = []

        samples.append({
            "uid": table.column("uid")[i].as_py(),
            "domain": domain,
            "document_type": table.column("document_type")[i].as_py(),
            "document_description": table.column("document_description")[i].as_py(),
            "document_format": doc_format,
            "locale": table.column("locale")[i].as_py(),
            "text": table.column("text")[i].as_py(),
            "spans": spans,
            "text_tagged": table.column("text_tagged")[i].as_py(),
        })

    print(f"[INFO] Loaded {len(samples)} Nemotron-PII samples"
          + (f" (max_samples={max_samples})" if max_samples else "")
          + (f" (domains={domains})" if domains else "")
          + (f" (formats={document_formats})" if document_formats else ""))
    return samples


def normalize_sample(sample: dict) -> dict:
    """Normalize a Nemotron-PII sample to the internal span format.

    Converts Nemotron-PII's native format into the format used by the
    evaluation pipeline.

    Returns:
        {
            "id": str,
            "text": str,
            "spans": [
                {
                    "entity_type": str,  # Mapped to Presidio/Aelvyril type
                    "start": int,
                    "end": int,
                    "text": str,
                    "label": str,        # Original Nemotron label
                }
            ],
            "domain": str,
            "document_type": str,
            "document_format": str,
        }
    """
    spans: List[dict] = []
    for span in sample.get("spans", []):
        label = span.get("label", "UNKNOWN")
        if label in EXCLUDED_LABELS:
            continue
        mapped_type = NEMOTRON_ENTITY_MAP.get(label, label.upper())

        spans.append({
            "entity_type": mapped_type,
            "start": span.get("start", 0),
            "end": span.get("end", 0),
            "text": str(span.get("text", "")),
            "label": label,
        })

    return {
        "id": sample.get("uid", ""),
        "text": sample.get("text", ""),
        "spans": spans,
        "domain": sample.get("domain", ""),
        "document_type": sample.get("document_type", ""),
        "document_format": sample.get("document_format", ""),
    }


# ── Backward-compatible aliases ────────────────────────────────────────────────
# These allow existing code (run.py, dashboard, etc.) to continue working
# with minimal changes while the internal implementation uses Nemotron-PII.

download_pii_bench = download_nemotron_pii
load_pii_bench = load_nemotron_pii
normalize_pii_bench_sample = normalize_sample


# ── Internal utilities ────────────────────────────────────────────────────────


def _compute_file_hash(filepath: str) -> str:
    """Compute SHA256 hash of a file."""
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()
