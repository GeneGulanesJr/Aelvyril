"""
Adversarial robustness evaluator — obfuscation, noise, and edge-case handling.

Evaluates how well Aelvyril handles PII that has been deliberately obfuscated
or hidden using various adversarial techniques:

    - Unicode homoglyph substitution (e.g., Cyrillic 'а' for Latin 'a')
    - Zero-width character injection
    - Base64-encoded PII
    - Leet-speak transformations
    - Partial redaction (e.g., SSN: ***-**-1234)
    - Mixed-script obfuscation
    - Whitespace/separator injection
    - Character repetition (e.g., jjjooohhnnn)

Also evaluates edge cases:
    - Very short texts (single entity)
    - Very long texts (boundary detection)
    - Nested entities (email inside a URL)
    - Overlapping entity types
    - Code-context PII (variable assignments, JSON blobs)

Sources:
    - RoBERTa-PII-Synth model for adversarial PII generation concepts
    - NIST SP 800-188 (De-identification guidance)
    - Unicode TR36 (Security Considerations)

Usage:
    python -m benchmarks.supplementary.adversarial_evaluator
    python -m benchmarks.supplementary.adversarial_evaluator --category all
    python -m benchmarks.supplementary.adversarial_evaluator --category homoglyph
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import unicodedata
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from benchmarks.common.metrics import (
    EntityMetrics,
    SpanMatch,
    evaluate_entity_types,
    compute_aggregate,
)
from benchmarks.common.reporting import generate_run_manifest
from benchmarks.common.utils import set_seeds
from benchmarks.presidio_research.aelvyril_evaluator import AelvyrilEvaluator


# ── Adversarial Transformations ─────────────────────────────────────────────────

# Unicode homoglyphs: visually similar characters from different scripts
HOMOGLYPH_MAP: Dict[str, List[str]] = {
    "a": ["а", "ạ", "ą"],  # Cyrillic, etc.
    "e": ["е", "ẹ", "ę"],
    "o": ["о", "ọ", "ǫ"],
    "i": ["і", "ị"],
    "c": ["с", "ç"],
    "p": ["р"],
    "x": ["х"],
    "y": ["у"],
    "s": ["ѕ"],
    "n": ["п"],  # partial similarity
}

# Zero-width characters
ZERO_WIDTH_CHARS = [
    "\u200b",  # Zero-width space
    "\u200c",  # Zero-width non-joiner
    "\u200d",  # Zero-width joiner
    "\ufeff",  # BOM / zero-width no-break space
]


def inject_homoglyphs(text: str, pii_spans: List[dict], rate: float = 0.3) -> Tuple[str, List[dict]]:
    """Replace characters in PII spans with Unicode homoglyphs.

    Args:
        text: Original text.
        pii_spans: Gold spans marking PII locations.
        rate: Probability of replacing each character.

    Returns:
        (modified_text, adjusted_spans)
    """
    import random

    chars = list(text)
    offset = 0

    for span in sorted(pii_spans, key=lambda s: s["start"]):
        start = span["start"] + offset
        end = span["end"] + offset

        new_chars: List[str] = []
        for i in range(start, min(end, len(chars))):
            c = chars[i]
            lower = c.lower()
            if lower in HOMOGLYPH_MAP and random.random() < rate:
                replacement = random.choice(HOMOGLYPH_MAP[lower])
                # Preserve case
                if c.isupper():
                    replacement = replacement.upper()
                new_chars.append(replacement)
            else:
                new_chars.append(c)

        chars[start:end] = new_chars
        new_len = len(new_chars)
        old_len = end - start
        offset += new_len - old_len

    # Adjust spans
    new_text = "".join(chars)
    adjusted = []
    for span in pii_spans:
        adjusted.append({
            **span,
            "start": span["start"],  # Approximate — homoglyphs are same width
            "end": span["end"],
        })

    return new_text, adjusted


def inject_zero_width(text: str, pii_spans: List[dict], positions: int = 2) -> Tuple[str, List[dict]]:
    """Inject zero-width characters into PII spans.

    Args:
        text: Original text.
        pii_spans: Gold PII spans.
        positions: Number of zero-width chars to inject per span.

    Returns:
        (modified_text, adjusted_spans)
    """
    import random

    chars = list(text)
    offset = 0

    for span in sorted(pii_spans, key=lambda s: s["start"]):
        start = span["start"] + offset
        end = span["end"] + offset
        span_len = end - start

        if span_len < 2:
            continue

        # Insert at random positions within the span
        insert_positions = sorted(
            random.sample(range(start, end), min(positions, span_len - 1)),
            reverse=True,
        )

        for pos in insert_positions:
            zw_char = random.choice(ZERO_WIDTH_CHARS)
            chars.insert(pos, zw_char)
            offset += 1

        span["end"] = span["end"] + positions

    new_text = "".join(chars)
    return new_text, pii_spans


def encode_base64_spans(text: str, pii_spans: List[dict]) -> Tuple[str, List[dict]]:
    """Base64-encode PII spans in the text.

    Returns:
        (modified_text, adjusted_spans with new positions)
    """
    chars = list(text)
    offset = 0

    adjusted = []
    for span in sorted(pii_spans, key=lambda s: s["start"]):
        start = span["start"] + offset
        end = span["end"] + offset
        original_text = "".join(chars[start:end])

        encoded = base64.b64encode(original_text.encode()).decode()
        chars[start:end] = list(encoded)

        new_len = len(encoded)
        old_len = end - start
        offset += new_len - old_len

        adjusted.append({
            **span,
            "start": start,
            "end": start + new_len,
            "text": encoded,
            "transform": "base64",
        })

    return "".join(chars), adjusted


def leet_speak(text: str, pii_spans: List[dict]) -> Tuple[str, List[dict]]:
    """Apply leet-speak transformation to PII spans.

    Common substitutions: a→4, e→3, i→1, o→0, s→5, t→7
    """
    import random

    leet_map = {"a": "4", "e": "3", "i": "1", "o": "0", "s": "5", "t": "7",
                "A": "4", "E": "3", "I": "1", "O": "0", "S": "5", "T": "7"}

    chars = list(text)

    for span in pii_spans:
        start, end = span["start"], span["end"]
        for i in range(start, min(end, len(chars))):
            if chars[i] in leet_map and random.random() < 0.5:
                chars[i] = leet_map[chars[i]]

    return "".join(chars), pii_spans


def inject_separators(text: str, pii_spans: List[dict], sep: str = " ") -> Tuple[str, List[dict]]:
    """Inject separators between characters in PII spans.

    E.g., "john@example.com" → "j o h n @ e x a m p l e . c o m"
    """
    chars = list(text)
    offset = 0

    for span in sorted(pii_spans, key=lambda s: s["start"]):
        start = span["start"] + offset
        end = span["end"] + offset

        original = chars[start:end]
        spaced = []
        for i, c in enumerate(original):
            spaced.append(c)
            if i < len(original) - 1:
                spaced.append(sep)

        chars[start:end] = spaced
        new_len = len(spaced)
        old_len = end - start
        offset += new_len - old_len

        span["end"] = span["end"] + (new_len - old_len)

    return "".join(chars), pii_spans


# ── Test Case Generators ────────────────────────────────────────────────────────


@dataclass
class AdversarialTestCase:
    """A single adversarial test case."""

    category: str
    original_text: str
    modified_text: str
    original_spans: List[dict]
    modified_spans: List[dict]
    transform: str
    description: str = ""


def generate_adversarial_test_suite(seed: int = 42) -> List[AdversarialTestCase]:
    """Generate a comprehensive suite of adversarial test cases.

    Categories:
        - homoglyph: Unicode homoglyph substitution
        - zero_width: Zero-width character injection
        - base64: Base64 encoding of PII
        - leet: Leet-speak transformation
        - separator: Whitespace/separator injection
        - partial: Partial redaction
        - edge_case: Edge cases (short text, nested entities, code context)
    """
    import random
    from faker import Faker

    Faker.seed(seed)
    fake = Faker("en_US")
    random.seed(seed)

    test_cases: List[AdversarialTestCase] = []

    # ── Base PII templates ──────────────────────────────────────────────
    base_cases = [
        {
            "text": f"Contact John Smith at john.smith@example.com or 555-123-4567.",
            "spans": [
                {"entity_type": "PERSON", "start": 8, "end": 18, "text": "John Smith"},
                {"entity_type": "EMAIL_ADDRESS", "start": 22, "end": 43, "text": "john.smith@example.com"},
                {"entity_type": "PHONE_NUMBER", "start": 47, "end": 59, "text": "555-123-4567"},
            ],
        },
        {
            "text": f"SSN: 123-45-6789, Credit Card: 4532-1234-5678-9010",
            "spans": [
                {"entity_type": "US_SSN", "start": 5, "end": 16, "text": "123-45-6789"},
                {"entity_type": "CREDIT_CARD", "start": 31, "end": 50, "text": "4532-1234-5678-9010"},
            ],
        },
        {
            "text": f"Server admin@192.168.1.100 reported by Alice from New York.",
            "spans": [
                {"entity_type": "IP_ADDRESS", "start": 11, "end": 25, "text": "192.168.1.100"},
                {"entity_type": "PERSON", "start": 37, "end": 42, "text": "Alice"},
                {"entity_type": "LOCATION", "start": 48, "end": 56, "text": "New York"},
            ],
        },
        {
            "text": f"IBAN: GB82WEST12345698765432 for Acme Corp.",
            "spans": [
                {"entity_type": "IBAN_CODE", "start": 6, "end": 28, "text": "GB82WEST12345698765432"},
                {"entity_type": "ORGANIZATION", "start": 33, "end": 42, "text": "Acme Corp."},
            ],
        },
    ]

    # ── Generate adversarial variants ───────────────────────────────────

    for base in base_cases:
        text = base["text"]
        spans = [dict(s) for s in base["spans"]]

        # Homoglyph variants
        mod_text, mod_spans = inject_homoglyphs(text, [dict(s) for s in spans], rate=0.3)
        test_cases.append(AdversarialTestCase(
            category="homoglyph",
            original_text=text,
            modified_text=mod_text,
            original_spans=spans,
            modified_spans=mod_spans,
            transform="homoglyph_30pct",
            description="30% of PII chars replaced with Unicode homoglyphs",
        ))

        # Zero-width injection
        mod_text, mod_spans = inject_zero_width(text, [dict(s) for s in spans], positions=2)
        test_cases.append(AdversarialTestCase(
            category="zero_width",
            original_text=text,
            modified_text=mod_text,
            original_spans=spans,
            modified_spans=mod_spans,
            transform="zero_width_x2",
            description="2 zero-width chars injected per PII span",
        ))

        # Base64
        mod_text, mod_spans = encode_base64_spans(text, [dict(s) for s in spans])
        test_cases.append(AdversarialTestCase(
            category="base64",
            original_text=text,
            modified_text=mod_text,
            original_spans=spans,
            modified_spans=mod_spans,
            transform="base64_encode",
            description="PII spans Base64-encoded",
        ))

        # Leet speak
        mod_text, mod_spans = leet_speak(text, [dict(s) for s in spans])
        test_cases.append(AdversarialTestCase(
            category="leet",
            original_text=text,
            modified_text=mod_text,
            original_spans=spans,
            modified_spans=mod_spans,
            transform="leet_speak_50pct",
            description="50% of PII chars leet-speak transformed",
        ))

        # Separator injection
        mod_text, mod_spans = inject_separators(text, [dict(s) for s in spans], sep=" ")
        test_cases.append(AdversarialTestCase(
            category="separator",
            original_text=text,
            modified_text=mod_text,
            original_spans=spans,
            modified_spans=mod_spans,
            transform="space_injection",
            description="Spaces injected between PII characters",
        ))

    # ── Edge cases ──────────────────────────────────────────────────────
    edge_cases = [
        # Very short text
        AdversarialTestCase(
            category="edge_case",
            original_text="john@example.com",
            modified_text="john@example.com",
            original_spans=[{"entity_type": "EMAIL_ADDRESS", "start": 0, "end": 16, "text": "john@example.com"}],
            modified_spans=[{"entity_type": "EMAIL_ADDRESS", "start": 0, "end": 16, "text": "john@example.com"}],
            transform="short_text",
            description="Minimal text with single entity",
        ),
        # Partial redaction
        AdversarialTestCase(
            category="edge_case",
            original_text="SSN: ***-**-6789",
            modified_text="SSN: ***-**-6789",
            original_spans=[{"entity_type": "US_SSN", "start": 5, "end": 15, "text": "***-**-6789"}],
            modified_spans=[{"entity_type": "US_SSN", "start": 5, "end": 15, "text": "***-**-6789"}],
            transform="partial_redaction",
            description="Partially redacted SSN",
        ),
        # Code context
        AdversarialTestCase(
            category="edge_case",
            original_text='const config = { email: "admin@corp.com", apiKey: "sk-1234567890abcdef" };',
            modified_text='const config = { email: "admin@corp.com", apiKey: "sk-1234567890abcdef" };',
            original_spans=[
                {"entity_type": "EMAIL_ADDRESS", "start": 25, "end": 40, "text": "admin@corp.com"},
                {"entity_type": "API_KEY", "start": 52, "end": 70, "text": "sk-1234567890abcdef"},
            ],
            modified_spans=[
                {"entity_type": "EMAIL_ADDRESS", "start": 25, "end": 40, "text": "admin@corp.com"},
                {"entity_type": "API_KEY", "start": 52, "end": 70, "text": "sk-1234567890abcdef"},
            ],
            transform="code_context",
            description="PII in JavaScript code",
        ),
        # JSON blob
        AdversarialTestCase(
            category="edge_case",
            original_text='{"user": "Jane Doe", "ssn": "123-45-6789", "ip": "10.0.0.1"}',
            modified_text='{"user": "Jane Doe", "ssn": "123-45-6789", "ip": "10.0.0.1"}',
            original_spans=[
                {"entity_type": "PERSON", "start": 9, "end": 17, "text": "Jane Doe"},
                {"entity_type": "US_SSN", "start": 26, "end": 37, "text": "123-45-6789"},
                {"entity_type": "IP_ADDRESS", "start": 44, "end": 51, "text": "10.0.0.1"},
            ],
            modified_spans=[
                {"entity_type": "PERSON", "start": 9, "end": 17, "text": "Jane Doe"},
                {"entity_type": "US_SSN", "start": 26, "end": 37, "text": "123-45-6789"},
                {"entity_type": "IP_ADDRESS", "start": 44, "end": 51, "text": "10.0.0.1"},
            ],
            transform="json_blob",
            description="PII in JSON structure",
        ),
        # Nested entities
        AdversarialTestCase(
            category="edge_case",
            original_text="Visit https://john.example.com/profile for John's page.",
            modified_text="Visit https://john.example.com/profile for John's page.",
            original_spans=[
                {"entity_type": "Domain", "start": 6, "end": 31, "text": "https://john.example.com"},
                {"entity_type": "PERSON", "start": 42, "end": 46, "text": "John"},
            ],
            modified_spans=[
                {"entity_type": "Domain", "start": 6, "end": 31, "text": "https://john.example.com"},
                {"entity_type": "PERSON", "start": 42, "end": 46, "text": "John"},
            ],
            transform="nested_entities",
            description="URL containing person name",
        ),
        # Mixed obfuscation
        AdversarialTestCase(
            category="edge_case",
            original_text=f"User {fake.user_name()} logged in from {fake.ipv4()} at {fake.date_time()}",
            modified_text=f"User {fake.user_name()} logged in from {fake.ipv4()} at {fake.date_time()}",
            original_spans=[],
            modified_spans=[],
            transform="mixed_no_pii",
            description="Non-PII text that looks like it might contain PII",
        ),
    ]

    test_cases.extend(edge_cases)

    # ── Generate Faker-based bulk cases ─────────────────────────────────
    for i in range(100):
        person = fake.name()
        email = fake.email()
        phone = fake.phone_number()
        ssn = fake.ssn()
        ip = fake.ipv4_public()

        templates = [
            (f"My name is {person}, call me at {phone}.", [
                ("PERSON", person), ("PHONE_NUMBER", phone),
            ]),
            (f"Email {email} belongs to {person}.", [
                ("EMAIL_ADDRESS", email), ("PERSON", person),
            ]),
            (f"SSN: {ssn}, IP: {ip}", [
                ("US_SSN", ssn), ("IP_ADDRESS", ip),
            ]),
        ]

        text, entities = random.choice(templates)
        spans: List[dict] = []
        for entity_type, value in entities:
            idx = text.find(value)
            if idx >= 0:
                spans.append({
                    "entity_type": entity_type,
                    "start": idx,
                    "end": idx + len(value),
                    "text": value,
                })

        # Apply random adversarial transform
        transforms = [
            lambda t, s: inject_homoglyphs(t, s, 0.2),
            lambda t, s: inject_zero_width(t, s, 1),
            lambda t, s: leet_speak(t, s),
            lambda t, s: inject_separators(t, s, "."),
            lambda t, s: (t, s),  # No transform (control)
        ]

        transform_fn = random.choice(transforms)
        mod_text, mod_spans = transform_fn(text, [dict(s) for s in spans])

        test_cases.append(AdversarialTestCase(
            category="bulk",
            original_text=text,
            modified_text=mod_text,
            original_spans=spans,
            modified_spans=mod_spans,
            transform="random_mixed",
            description="Bulk adversarial test with random transform",
        ))

    return test_cases


# ── Evaluation ──────────────────────────────────────────────────────────────────


@dataclass
class AdversarialCategoryResult:
    """Results for a single adversarial category."""

    category: str
    total_cases: int = 0
    detected_original: int = 0
    detected_modified: int = 0
    detection_rate_original: float = 0.0
    detection_rate_modified: float = 0.0
    robustness_score: float = 0.0  # modified_rate / original_rate
    per_transform: Dict[str, Dict] = field(default_factory=dict)

    def to_dict(self) -> Dict:
        return {
            "category": self.category,
            "total_cases": self.total_cases,
            "detected_original": self.detected_original,
            "detected_modified": self.detected_modified,
            "detection_rate_original": round(self.detection_rate_original, 4),
            "detection_rate_modified": round(self.detection_rate_modified, 4),
            "robustness_score": round(self.robustness_score, 4),
            "per_transform": self.per_transform,
        }


@dataclass
class AdversarialResult:
    """Complete adversarial robustness evaluation result."""

    overall_robustness: float = 0.0
    categories: Dict[str, AdversarialCategoryResult] = field(default_factory=dict)
    total_test_cases: int = 0
    edge_case_details: List[Dict] = field(default_factory=list)

    def to_dict(self) -> Dict:
        return {
            "overall_robustness": round(self.overall_robustness, 4),
            "categories": {k: v.to_dict() for k, v in self.categories.items()},
            "total_test_cases": self.total_test_cases,
            "edge_case_details": self.edge_case_details,
        }


def run_adversarial_evaluation(
    service_url: str | None = None,
    seed: int = 42,
    categories: Optional[List[str]] = None,
    output_dir: str = "benchmarks/supplementary/results",
) -> AdversarialResult:
    """Run adversarial robustness evaluation.

    Args:
        service_url: Aelvyril /analyze endpoint.
        seed: Random seed.
        categories: Categories to test (None = all).
        output_dir: Results directory.

    Returns:
        AdversarialResult with robustness scores.
    """
    set_seeds(seed)

    # Generate test suite
    test_cases = generate_adversarial_test_suite(seed)

    # Filter by category
    if categories and "all" not in categories:
        test_cases = [tc for tc in test_cases if tc.category in categories]

    print(f"\n[INFO] Generated {len(test_cases)} adversarial test cases")

    # Initialize evaluator
    evaluator = AelvyrilEvaluator(service_url=service_url)

    # Run evaluation
    print(f"\n{'='*60}")
    print("Adversarial Robustness Evaluation")
    print(f"{'='*60}")

    # Group by category
    category_cases: Dict[str, List[AdversarialTestCase]] = {}
    for tc in test_cases:
        category_cases.setdefault(tc.category, []).append(tc)

    results: Dict[str, AdversarialCategoryResult] = {}
    edge_cases: List[Dict] = []

    for cat_name, cases in sorted(category_cases.items()):
        cat_result = AdversarialCategoryResult(category=cat_name, total_cases=len(cases))
        transform_stats: Dict[str, Dict[str, int]] = {}

        for tc in cases:
            # Test original (unmodified) text
            if tc.original_spans:
                orig_detected = evaluator.predict(tc.original_text)
                orig_count = len(orig_detected)
                cat_result.detected_original += min(orig_count, len(tc.original_spans))
            else:
                orig_count = 0
                cat_result.detected_original += 0

            # Test modified (adversarial) text
            if tc.modified_spans:
                mod_detected = evaluator.predict(tc.modified_text)
                mod_count = len(mod_detected)
                cat_result.detected_modified += min(mod_count, len(tc.modified_spans))
            else:
                mod_count = 0
                cat_result.detected_modified += 0

            # Track per-transform stats
            transform = tc.transform
            if transform not in transform_stats:
                transform_stats[transform] = {"total": 0, "orig": 0, "mod": 0}
            transform_stats[transform]["total"] += 1
            transform_stats[transform]["orig"] += orig_count
            transform_stats[transform]["mod"] += mod_count

            # Track edge cases
            if tc.category == "edge_case":
                edge_cases.append({
                    "transform": tc.transform,
                    "description": tc.description,
                    "original_spans": len(tc.original_spans),
                    "detected_in_original": orig_count,
                    "detected_in_modified": mod_count,
                    "original_text_preview": tc.original_text[:80],
                })

        # Compute rates
        total_orig_spans = sum(
            len(tc.original_spans) for tc in cases
        )
        total_mod_spans = sum(
            len(tc.modified_spans) for tc in cases
        )

        cat_result.detection_rate_original = (
            cat_result.detected_original / total_orig_spans if total_orig_spans else 1.0
        )
        cat_result.detection_rate_modified = (
            cat_result.detected_modified / total_mod_spans if total_mod_spans else 1.0
        )
        cat_result.robustness_score = (
            cat_result.detection_rate_modified / cat_result.detection_rate_original
            if cat_result.detection_rate_original > 0 else 1.0
        )

        # Per-transform breakdown
        for transform, stats in transform_stats.items():
            cat_result.per_transform[transform] = {
                "total_cases": stats["total"],
                "detected_original": stats["orig"],
                "detected_modified": stats["mod"],
            }

        results[cat_name] = cat_result
        print(f"  {cat_name}: robustness={cat_result.robustness_score:.4f} "
              f"(original: {cat_result.detection_rate_original:.4f}, "
              f"modified: {cat_result.detection_rate_modified:.4f})")

    # Overall robustness (average across categories)
    if results:
        overall = sum(r.robustness_score for r in results.values()) / len(results)
    else:
        overall = 0.0

    adversarial_result = AdversarialResult(
        overall_robustness=overall,
        categories=results,
        total_test_cases=len(test_cases),
        edge_case_details=edge_cases,
    )

    # Save results
    os.makedirs(output_dir, exist_ok=True)

    result_json = {
        "aelvyril_version": "dev",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "benchmark": "adversarial_robustness",
        "results": adversarial_result.to_dict(),
        "config": {"seed": seed, "categories": categories or "all"},
    }

    results_path = os.path.join(output_dir, "adversarial_results.json")
    with open(results_path, "w") as f:
        json.dump(result_json, f, indent=2)

    latest_path = os.path.join(output_dir, "adversarial_latest.json")
    with open(latest_path, "w") as f:
        json.dump(result_json, f, indent=2)

    generate_run_manifest(output_dir, seed=seed)

    # Generate report
    _generate_adversarial_report(adversarial_result, output_dir)

    # Print summary
    _print_adversarial_summary(adversarial_result)

    return adversarial_result


def _print_adversarial_summary(result: AdversarialResult) -> None:
    """Print adversarial robustness summary."""
    print(f"\n{'='*60}")
    print("Adversarial Robustness Results")
    print(f"{'='*60}")
    print(f"Total test cases: {result.total_test_cases}")
    print(f"Overall robustness: {result.overall_robustness:.4f}")
    print()

    print(f"{'Category':<20} {'Orig Rate':>10} {'Mod Rate':>10} {'Robustness':>12}")
    print("-" * 55)
    for name, cat in sorted(result.categories.items()):
        print(
            f"{name:<20} {cat.detection_rate_original:>10.4f} "
            f"{cat.detection_rate_modified:>10.4f} {cat.robustness_score:>12.4f}"
        )

    if result.edge_case_details:
        print()
        print("Edge Case Details:")
        for ec in result.edge_case_details:
            status = "✅" if ec["detected_in_modified"] >= ec["original_spans"] else "❌"
            print(f"  {status} {ec['transform']}: {ec['description']}")


def _generate_adversarial_report(result: AdversarialResult, output_dir: str) -> str:
    """Generate adversarial robustness Markdown report."""
    lines: List[str] = []
    lines.append("# Adversarial Robustness Report — Obfuscation & Edge Case Handling")
    lines.append("")
    lines.append(f"**Generated:** {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    lines.append(f"**Total Test Cases:** {result.total_test_cases}")
    lines.append(f"**Overall Robustness Score:** {result.overall_robustness:.4f}")
    lines.append("")

    lines.append("## Robustness Score Interpretation")
    lines.append("")
    lines.append("| Score | Interpretation |")
    lines.append("|-------|---------------|")
    lines.append("| ≥ 0.90 | Excellent — detection survives most obfuscation |")
    lines.append("| ≥ 0.70 | Good — handles common obfuscation well |")
    lines.append("| ≥ 0.50 | Moderate — degrades significantly under adversarial input |")
    lines.append("| < 0.50 | Poor — adversarial input easily evades detection |")
    lines.append("")

    # Per-category results
    lines.append("## Per-Category Results")
    lines.append("")
    lines.append(
        "| Category | Detection Rate (Original) | Detection Rate (Modified) | Robustness | Cases |"
    )
    lines.append(
        "|----------|--------------------------|--------------------------|------------|-------|"
    )
    for name, cat in sorted(result.categories.items()):
        emoji = "✅" if cat.robustness_score >= 0.7 else "⚠️" if cat.robustness_score >= 0.5 else "❌"
        lines.append(
            f"| {emoji} {name} | {cat.detection_rate_original:.4f} "
            f"| {cat.detection_rate_modified:.4f} "
            f"| {cat.robustness_score:.4f} | {cat.total_cases} |"
        )
    lines.append("")

    # Edge case details
    if result.edge_case_details:
        lines.append("## Edge Case Details")
        lines.append("")
        lines.append("| Transform | Description | Gold Spans | Detected | Status |")
        lines.append("|-----------|-------------|------------|----------|--------|")
        for ec in result.edge_case_details:
            status = "✅" if ec["detected_in_modified"] >= ec["original_spans"] else "❌"
            lines.append(
                f"| {ec['transform']} | {ec['description'][:60]} "
                f"| {ec['original_spans']} | {ec['detected_in_modified']} | {status} |"
            )
        lines.append("")

    # Adversarial techniques tested
    lines.append("## Adversarial Techniques Tested")
    lines.append("")
    lines.append("| Technique | Description | Impact |")
    lines.append("|-----------|-------------|--------|")
    lines.append("| Unicode Homoglyphs | Cyrillic/Latin substitution | Breaks regex matching on character identity |")
    lines.append("| Zero-Width Chars | Invisible chars between letters | May break tokenization |")
    lines.append("| Base64 Encoding | PII encoded as Base64 | Completely hides PII from regex |")
    lines.append("| Leet Speak | a→4, e→3, o→0 | Breaks regex character classes |")
    lines.append("| Separator Injection | Spaces/dots between chars | Breaks continuous pattern matching |")
    lines.append("| Partial Redaction | ***-**-1234 | Tests partial PII detection |")
    lines.append("| Code Context | PII in JSON/JS code | Context-dependent suppression |")
    lines.append("| Nested Entities | URL containing person name | Tests overlap resolution |")
    lines.append("")

    # Recommendations
    lines.append("## Recommendations")
    lines.append("")
    for name, cat in sorted(result.categories.items()):
        if cat.robustness_score < 0.7:
            lines.append(f"- **{name}** (robustness: {cat.robustness_score:.2f}): ")
            if name == "base64":
                lines.append("  Consider detecting and decoding Base64-encoded segments before PII analysis.")
            elif name == "homoglyph":
                lines.append("  Add Unicode normalization (NFKC) before regex matching.")
            elif name == "zero_width":
                lines.append("  Strip zero-width characters from input before analysis.")
            elif name == "leet":
                lines.append("  Add leet-speak reverse mapping in preprocessing.")
            elif name == "separator":
                lines.append("  Normalize separators before pattern matching.")
            else:
                lines.append("  Investigate failure patterns and improve detection.")
    lines.append("")

    report_path = os.path.join(output_dir, "ADVERSARIAL_REPORT.md")
    with open(report_path, "w") as f:
        f.write("\n".join(lines))

    print(f"Adversarial report saved → {report_path}")
    return report_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Adversarial Robustness Evaluation")
    parser.add_argument("--service-url", type=str, default="http://localhost:3000/analyze")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--category",
        nargs="+",
        default=["all"],
        choices=["all", "homoglyph", "zero_width", "base64", "leet", "separator", "edge_case", "bulk"],
    )
    parser.add_argument("--output-dir", type=str, default="benchmarks/supplementary/results")
    args = parser.parse_args()

    run_adversarial_evaluation(
        service_url=args.service_url,
        seed=args.seed,
        categories=args.category,
        output_dir=args.output_dir,
    )


if __name__ == "__main__":
    main()
