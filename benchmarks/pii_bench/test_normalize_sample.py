"""
Unit tests: normalize_sample ↔ PiiType::Display alignment.

Every value in NEMOTRON_ENTITY_MAP must be a string that Aelvyril's
PiiType::Display can produce. If the two sides drift, scoring silently
fails (strict string equality returns zero for that entity type).

A table-driven test catches regressions immediately.

Usage:
    python -m pytest benchmarks/pii_bench/test_normalize_sample.py -v
    python -m pytest benchmarks/pii_bench/test_normalize_sample.py::test_entity_map_values_match_pii_type_display
"""

from __future__ import annotations

from benchmarks.pii_bench.downloader import (
    NEMOTRON_ENTITY_MAP,
    EXCLUDED_LABELS,
    NON_PII_DEMOGRAPHIC_LABELS,
    normalize_sample,
)


# ── Reference: PiiType::Display output strings ──────────────────────────────
#
# Must match src-tauri/src/pii/recognizers.rs impl Display for PiiType exactly.
# If you add a new PiiType variant, add its Display string here AND add the
# corresponding Nemotron label in NEMOTRON_ENTITY_MAP.
#
# Excluded types (not in this set but valid in gold):
#   - "NRP" — demographic attributes, excluded via EXCLUDED_LABELS
#   - "ID"  — generic catch-all, no specific recognizer

PII_TYPE_DISPLAY_STRINGS: set = {
    # Contact
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    # Network
    "IP_ADDRESS",
    "URL",
    # Financial
    "CREDIT_CARD",
    "US_SSN",
    "IBAN_CODE",
    "API_KEY",
    "SWIFT_CODE",
    "US_BANK_NUMBER",
    # Temporal
    "DATE_TIME",
    "AGE",
    # Location (fine-grained, no collapsing)
    "CITY",
    "US_STATE",
    "STREET_ADDRESS",
    "COUNTRY",
    "LOCATION",
    "US_ZIP_CODE",
    # Identities
    "PERSON",
    "ORGANIZATION",
    "TITLE",
    "NATIONALITY",
    # Medical
    "MEDICAL_RECORD",
    # Government IDs
    "US_PASSPORT",
    "US_DRIVER_LICENSE",
}

# Types in NEMOTRON_ENTITY_MAP that have no specific PiiType variant
# but are expected / tolerated in gold data.
KNOWN_GOLD_ONLY_TYPES: set = {"NRP", "ID"}

# Types in PiiType::Display that have no Nemotron equivalent (gold never
# produces them, but Aelvyril emits them). These are fine — they just get
# zero gold count in per-entity breakdowns.
KNOWN_AEVYRIL_ONLY_TYPES: set = {
    "IBAN_CODE",
    "SWIFT_CODE",
    "US_BANK_NUMBER",
    "US_PASSPORT",
    "US_DRIVER_LICENSE",
    "MEDICAL_RECORD",
    "NATIONALITY",
    "TITLE",
    "AGE",
}


# ── Tests ────────────────────────────────────────────────────────────────────


def test_entity_map_values_match_pii_type_display() -> None:
    """Every NEMOTRON_ENTITY_MAP value must be a valid PiiType::Display string.

    Exceptions:
      - "NRP" (demographic, not PII — excluded from eval)
      - "ID"  (generic catch-all, no specific recognizer)

    If this test fails, either:
      (a) A new Nemotron label was added to NEMOTRON_ENTITY_MAP but its
          canonical type doesn't match any PiiType variant → fix the value.
      (b) A new PiiType variant was added but PII_TYPE_DISPLAY_STRINGS wasn't
          updated → add the Display string here.
    """
    map_values = set(NEMOTRON_ENTITY_MAP.values())
    unsupported = map_values - PII_TYPE_DISPLAY_STRINGS - KNOWN_GOLD_ONLY_TYPES

    assert not unsupported, (
        f"NEMOTRON_ENTITY_MAP contains {len(unsupported)} values that have "
        f"no matching PiiType::Display string: {sorted(unsupported)}. "
        f"Either add them to NEMOTRON_ENTITY_MAP with a correct value, "
        f"add them to KNOWN_GOLD_ONLY_TYPES if they're intentional, "
        f"or update PII_TYPE_DISPLAY_STRINGS if a new PiiType was added."
    )


def test_pii_type_display_strings_have_mapping() -> None:
    """Every PiiType::Display string should have a Nemotron mapping (or be a
    known Aelvyril-only type).

    If this test fails, a new PiiType variant was added but no corresponding
    Nemotron label exists in NEMOTRON_ENTITY_MAP. Either add it or document
    it as KNOWN_AEVYRIL_ONLY_TYPES.
    """
    map_values = set(NEMOTRON_ENTITY_MAP.values())
    unmapped = PII_TYPE_DISPLAY_STRINGS - map_values - KNOWN_AEVYRIL_ONLY_TYPES

    assert not unmapped, (
        f"PiiType::Display types with no Nemotron mapping: {sorted(unmapped)}. "
        f"Add a Nemotron label → canonical type entry in NEMOTRON_ENTITY_MAP "
        f"or add to KNOWN_AEVYRIL_ONLY_TYPES."
    )


def test_domain_maps_to_url() -> None:
    """'domain' must map to 'URL' to match PiiType::Domain → Display('URL')."""
    assert NEMOTRON_ENTITY_MAP.get("domain") == "URL", (
        "NEMOTRON_ENTITY_MAP[\"domain\"] must be 'URL' to match "
        "PiiType::Domain::Display. Got: " + repr(NEMOTRON_ENTITY_MAP.get("domain"))
    )


def test_excluded_labels_do_not_appear_in_normalized_spans() -> None:
    """Labels in EXCLUDED_LABELS must be filtered out by normalize_sample."""
    test_sample = {
        "uid": "test-001",
        "text": "John is male. His race is Asian.",
        "spans": [
            # Demographic label — should be excluded
            {"start": 8, "end": 12, "text": "male", "label": "gender"},
            # Non-excluded PII — should survive
            {"start": 0, "end": 4, "text": "John", "label": "first_name"},
        ],
        "domain": "Healthcare",
        "document_type": "patient intake",
        "document_format": "unstructured",
        "locale": "us",
        "text_tagged": "",
    }

    normalized = normalize_sample(test_sample)
    excluded_types = [s["entity_type"] for s in normalized["spans"]]

    assert "NRP" not in excluded_types, (
        f"Gender label was excluded but its entity type 'NRP' appears "
        f"in normalized spans: {normalized['spans']}"
    )
    # The person span should survive
    person_spans = [s for s in normalized["spans"] if s["entity_type"] == "PERSON"]
    assert len(person_spans) == 1, (
        f"Expected 1 PERSON span, got: {normalized['spans']}"
    )


def test_api_key_password_map_to_api_key() -> None:
    """'api_key' and 'password' labels must both map to 'API_KEY'."""
    test_sample = {
        "uid": "test-002",
        "text": "API: sk-abc123DEFghijklmnopQRSTUVWXYZ, pw: mypassword123!",
        "spans": [
            {"start": 5, "end": 32, "text": "sk-abc123DEFghijklmnopQRSTUVWXYZ", "label": "api_key"},
            {"start": 38, "end": 53, "text": "mypassword123!", "label": "password"},
        ],
        "domain": "Technology",
        "document_type": "config",
        "document_format": "structured",
        "locale": "us",
        "text_tagged": "",
    }

    normalized = normalize_sample(test_sample)
    api_types = [s["entity_type"] for s in normalized["spans"]]

    assert all(t == "API_KEY" for t in api_types), (
        f"Both api_key and password should map to 'API_KEY'. "
        f"Got: {api_types}"
    )
    assert len(normalized["spans"]) == 2, (
        f"Expected 2 spans, got {len(normalized['spans'])}"
    )


def test_unknown_label_falls_through_as_uppercase() -> None:
    """Unknown labels are passed through as label.upper()."""
    test_sample = {
        "uid": "test-003",
        "text": "some custom field",
        "spans": [
            {"start": 0, "end": 4, "text": "some", "label": "custom_field_type"},
        ],
        "domain": "Technology",
        "document_type": "log",
        "document_format": "unstructured",
        "locale": "us",
        "text_tagged": "",
    }

    normalized = normalize_sample(test_sample)
    assert normalized["spans"][0]["entity_type"] == "CUSTOM_FIELD_TYPE", (
        f"Unknown label should pass through as uppercase. "
        f"Got: {normalized['spans'][0]['entity_type']}"
    )


def test_excluded_labels_set_comprehensive() -> None:
    """Every demographic label must be in both NON_PII_DEMOGRAPHIC_LABELS
    and EXCLUDED_LABELS."""
    expected_demographics = {
        "gender",
        "race_ethnicity",
        "religious_belief",
        "political_view",
        "sexuality",
    }
    assert NON_PII_DEMOGRAPHIC_LABELS == expected_demographics, (
        f"NON_PII_DEMOGRAPHIC_LABELS mismatch. "
        f"Expected: {expected_demographics}, Got: {NON_PII_DEMOGRAPHIC_LABELS}"
    )
    for label in expected_demographics:
        assert label in EXCLUDED_LABELS, (
            f"Label '{label}' is in NON_PII_DEMOGRAPHIC_LABELS but not in "
            f"EXCLUDED_LABELS. Every demographic label must be excluded."
        )


def test_normalize_sample_excludes_label_types() -> None:
    """Verify that normalize_sample actually skips spans whose label is
    in EXCLUDED_LABELS."""
    sample = {
        "uid": "test-004",
        "text": "Gender: Female, Race: White",
        "spans": [
            {"start": 8, "end": 14, "text": "Female", "label": "gender"},
            {"start": 22, "end": 27, "text": "White", "label": "race_ethnicity"},
        ],
        "domain": "Healthcare",
        "document_type": "patient record",
        "document_format": "structured",
        "locale": "us",
        "text_tagged": "",
    }

    normalized = normalize_sample(sample)
    assert len(normalized["spans"]) == 0, (
        f"All spans had excluded labels, but normalized output has "
        f"{len(normalized['spans'])} spans: {normalized['spans']}"
    )
