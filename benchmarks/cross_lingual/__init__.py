"""
Cross-lingual PII detection benchmark support.

Extends the benchmark framework to evaluate PII detection accuracy
across multiple locales (de_DE, fr_FR, es_MX).

Architecture:
- Generates locale-specific synthetic PII data using stdlib-only generators
- Evaluates via the same /analyze endpoint with language parameter
- Reports per-locale and aggregated metrics

Usage:
    python -m benchmarks.cross_lingual --locales de_DE,fr_FR --num-samples 200
    python -m benchmarks.run --suite cross-lingual
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))


# ── Locale-Specific PII Patterns ───────────────────────────────────────────────

LOCALE_CONFIG = {
    "en_US": {
        "name": "English (US)",
        "phone_pattern": r"\b\d{3}[-.]?\d{3}[-.]?\d{4}\b",
        "date_formats": ["MM/DD/YYYY", "YYYY-MM-DD", "Month DD, YYYY"],
        "zip_pattern": r"\b\d{5}(?:-\d{4})?\b",
        "sample_names": [
            "John Smith", "Jane Doe", "Robert Johnson", "Emily Williams",
            "Michael Brown", "Sarah Davis", "David Wilson", "Jennifer Moore",
        ],
        "sample_cities": ["New York", "San Francisco", "Chicago", "Austin"],
        "sample_streets": ["Main St", "Oak Ave", "Market Blvd", "Pine Dr"],
        "sample_orgs": ["Acme Corp", "Tech Inc", "Global Solutions", "Data Systems"],
        "address_format": "{street}, {city}, {zip}",
    },
    "de_DE": {
        "name": "German (Germany)",
        "phone_pattern": r"\b\+\d{1,2}\s?\d{2,5}\s?\d{3,8}\b",
        "date_formats": ["DD.MM.YYYY", "DD.MM.YY"],
        "zip_pattern": r"\b\d{5}\b",
        "sample_names": [
            "Max Müller", "Anna Schmidt", "Hans Weber", "Maria Fischer",
            "Thomas Wagner", "Lisa Becker", "Klaus Hoffman", "Petra Klein",
        ],
        "sample_cities": ["Berlin", "München", "Hamburg", "Frankfurt"],
        "sample_streets": ["Hauptstraße", "Bahnhofstraße", "Schillerstraße", "Goetheallee"],
        "sample_orgs": ["Deutsche Bahn", "Siemens AG", "Bosch GmbH", "SAP SE"],
        "address_format": "{street} {hno}, {zip} {city}",
    },
    "fr_FR": {
        "name": "French (France)",
        "phone_pattern": r"\b\+\d{1,3}\s?\d{1}\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{2}\b",
        "date_formats": ["DD/MM/YYYY", "YYYY-MM-DD"],
        "zip_pattern": r"\b\d{5}\b",
        "sample_names": [
            "Jean Dupont", "Marie Martin", "Pierre Bernard", "Sophie Leroy",
            "Jacques Durand", "Claire Moreau", "Antoine Laurent", "Isabelle Simon",
        ],
        "sample_cities": ["Paris", "Lyon", "Marseille", "Toulouse"],
        "sample_streets": ["Rue de la Paix", "Avenue des Champs-Élysées", "Boulevard Saint-Germain"],
        "sample_orgs": ["Air France", "TotalEnergies", "BNP Paribas", "Orange SA"],
        "address_format": "{hno} {street}, {zip} {city}",
    },
    "es_MX": {
        "name": "Spanish (Mexico)",
        "phone_pattern": r"\b\+\d{2}\s?\d{2}\s?\d{4}\s?\d{4}\b",
        "date_formats": ["DD/MM/YYYY", "YYYY-MM-DD"],
        "zip_pattern": r"\b\d{5}\b",
        "sample_names": [
            "Carlos García", "María Hernández", "José López", "Ana Martínez",
            "Roberto González", "Laura Rodríguez", "Fernando Pérez", "Carmen Sánchez",
        ],
        "sample_cities": ["Ciudad de México", "Guadalajara", "Monterrey", "Puebla"],
        "sample_streets": ["Av. Reforma", "Calle Insurgentes", "Blvd. de la Luz"],
        "sample_orgs": ["Telcel", "América Móvil", "CFE", "Pemex"],
        "address_format": "{street} #{hno}, {zip}, {city}",
    },
}

# Email and IP patterns are universal across locales
UNIVERSAL_PATTERNS = {
    "email": r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
    "ip_address": r"\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b",
}


# ── Cross-Lingual Data Generator ────────────────────────────────────────────────


def generate_cross_lingual_sample(
    locale: str,
    seed: int = 42,
) -> Dict[str, Any]:
    """Generate a single synthetic PII sample for a given locale.

    Returns:
        Dict with 'text' (the sample string) and 'spans' (ground truth).
    """
    import random
    rng = random.Random(seed)

    config = LOCALE_CONFIG[locale]
    entities: List[Dict[str, Any]] = []

    # Build template with slots
    templates = [
        "My name is {person} and I work at {org}. Contact me at {email} or {phone}.",
        "Please send the report to {person} at {address}. My email is {email}.",
        "Meeting with {person} from {org} on {date}. Call {phone} if delayed.",
        "{person}, {org} — invoice #{invoice} for {amount} EUR. Deliver to {address}.",
        "Debug: user {person} connected from {ip} on {date}. Org: {org}.",
    ]

    template = rng.choice(templates)

    # Fill in entities
    person = rng.choice(config["sample_names"])
    org = rng.choice(config["sample_orgs"])
    city = rng.choice(config["sample_cities"])
    street = rng.choice(config["sample_streets"])
    hno = rng.randint(1, 150)

    # Email with locale-appropriate TLD hints
    email_domains = ["example.com", "mail.de" if "de" in locale else "gmail.com", "company.org"]
    email_local = person.lower().replace(" ", ".").replace("-", ".")
    email = f"{email_local}@{rng.choice(email_domains)}"

    # Phone number matching locale pattern
    phone = _generate_locale_phone(locale, rng)

    # Date in locale format
    date_fmt = rng.choice(config["date_formats"])
    date_val = _format_date(date_fmt, rng)

    # Address
    zip_code = str(rng.randint(10000, 99999))
    address = config["address_format"].format(
        street=street, city=city, zip=zip_code, hno=hno
    )

    # Additional values
    ip = f"{rng.randint(1,255)}.{rng.randint(0,255)}.{rng.randint(0,255)}.{rng.randint(1,254)}"
    invoice = f"INV-{rng.randint(10000,99999)}"
    amount = f"{rng.randint(100,50000):.2f}"

    # Credit card (universal format)
    cc = _generate_credit_card(rng)

    text = template.format(
        person=person, org=org, email=email, phone=phone,
        date=date_val, address=address, ip=ip,
        invoice=invoice, amount=amount,
    )

    # Build ground truth spans
    for entity_name, entity_type, value in [
        ("person", "PERSON", person),
        ("org", "ORGANIZATION", org),
        ("email", "EMAIL_ADDRESS", email),
        ("phone", "PHONE_NUMBER", phone),
        ("date", "DATE_TIME", date_val),
        ("address", "LOCATION", address),
        ("ip", "IP_ADDRESS", ip),
    ]:
        start = text.find(value)
        if start >= 0:
            entities.append({
                "entity_type": entity_type,
                "text": value,
                "start": start,
                "end": start + len(value),
            })

    # Credit card (might not be in template — try to find)
    cc_start = text.find(cc)
    if cc_start >= 0:
        entities.append({
            "entity_type": "CREDIT_CARD",
            "text": cc,
            "start": cc_start,
            "end": cc_start + len(cc),
        })

    return {"text": text, "spans": entities, "locale": locale}


def generate_cross_lingual_dataset(
    locales: List[str],
    num_samples: int = 200,
    seed: int = 42,
) -> List[Dict[str, Any]]:
    """Generate a synthetic multi-locale PII dataset.

    Returns:
        List of samples, evenly distributed across locales.
    """
    import random
    rng = random.Random(seed)

    samples = []
    samples_per_locale = max(1, num_samples // len(locales))
    sample_seed = seed

    for locale in locales:
        for i in range(samples_per_locale):
            sample = generate_cross_lingual_sample(locale, seed=sample_seed)
            samples.append(sample)
            sample_seed += 1

    rng.shuffle(samples)
    return samples


def _generate_locale_phone(locale: str, rng) -> str:
    """Generate a phone number matching locale conventions."""
    if locale == "de_DE":
        return f"+49 {rng.randint(30,179)} {rng.randint(1000000,9999999)}"
    elif locale == "fr_FR":
        return f"+33 1 {rng.randint(10,99)} {rng.randint(10,99)} {rng.randint(10,99)} {rng.randint(10,99)}"
    elif locale == "es_MX":
        return f"+52 {rng.randint(10,99)} {rng.randint(1000,9999)} {rng.randint(1000,9999)}"
    else:  # en_US
        return f"({rng.randint(200,999)}) {rng.randint(100,999)}-{rng.randint(1000,9999)}"


def _format_date(fmt: str, rng) -> str:
    """Format a random date according to locale convention."""
    import calendar
    month = rng.randint(1, 12)
    day = rng.randint(1, 28)
    year = rng.randint(2020, 2026)

    if fmt == "DD.MM.YYYY":
        return f"{day:02d}.{month:02d}.{year}"
    elif fmt == "DD.MM.YY":
        return f"{day:02d}.{month:02d}.{year % 100:02d}"
    elif fmt == "DD/MM/YYYY":
        return f"{day:02d}/{month:02d}/{year}"
    elif fmt == "MM/DD/YYYY":
        return f"{month:02d}/{day:02d}/{year}"
    elif fmt.startswith("Month"):
        month_name = calendar.month_name[month]
        return f"{month_name} {day}, {year}"
    else:  # YYYY-MM-DD
        return f"{year}-{month:02d}-{day:02d}"


def _generate_credit_card(rng) -> str:
    """Generate a plausible credit card number (passes Luhn)."""
    # Start with a real IIN range
    prefix = rng.choice(["4", "51", "52", "53", "54", "55", "37"])
    digits = [int(d) for d in prefix] + [rng.randint(0, 9) for _ in range(14)]
    # Calculate Luhn check digit
    checksum = 0
    for i, d in enumerate(reversed(digits)):
        digit = d * 2 if i % 2 == 1 else d
        checksum += digit if digit < 10 else digit - 9
    check = (10 - (checksum % 10)) % 10
    digits.append(check)
    return "".join(str(d) for d in digits)


# ── Cross-Lingual Evaluation ───────────────────────────────────────────────────


def evaluate_cross_lingual(
    service_url: str,
    locales: List[str] = None,
    num_samples: int = 200,
    seed: int = 42,
    output_dir: str = "benchmarks/cross_lingual/results",
) -> Dict[str, Any]:
    """Run cross-lingual evaluation against Aelvyril /analyze endpoint.

    Args:
        service_url: Aelvyril/Presidio analyze endpoint URL.
        locales: List of locale codes to evaluate. None = all supported.
        num_samples: Total samples across all locales.
        seed: Random seed for reproducibility.
        output_dir: Directory for result files.

    Returns:
        Dict with per-locale and aggregated results.
    """
    import requests

    if locales is None:
        locales = list(LOCALE_CONFIG.keys())

    print("=" * 60)
    print("Cross-Lingual PII Detection Evaluation")
    print("=" * 60)
    print(f"Locales: {', '.join(locales)}")
    print(f"Samples per locale: ~{num_samples // len(locales)}")
    print(f"Service: {service_url}")
    print(f"Seed: {seed}")
    print()

    dataset = generate_cross_lingual_dataset(locales, num_samples, seed)

    # Language code mapping for Presidio
    locale_to_lang = {"en_US": "en", "de_DE": "de", "fr_FR": "fr", "es_MX": "es"}

    per_locale: Dict[str, Dict[str, Any]] = {}
    total_tp, total_fp, total_fn = 0, 0, 0

    for locale in locales:
        lang = locale_to_lang.get(locale, "en")
        locale_samples = [s for s in dataset if s["locale"] == locale]
        lang_tp, lang_fp, lang_fn = 0, 0, 0
        failures = 0

        for sample in locale_samples:
            try:
                resp = requests.post(
                    service_url,
                    json={
                        "messages": [{"role": "user", "content": sample["text"]}],
                        "model": "none",
                    },
                    headers={
                        "Authorization": "Bearer aelvyril-benchmark-key",
                        "X-Benchmark-Mode": "raw-detections",
                    },
                    timeout=10,
                )
                resp.raise_for_status()
                predicted = resp.json()
            except Exception:
                failures += 1
                predicted = []

            # Compare predicted vs ground truth
            gold_spans = set(
                (s["entity_type"], s["start"], s["end"]) for s in sample["spans"]
            )
            pred_spans = set(
                (p.get("entity_type", ""), p.get("start", -1), p.get("end", -1))
                for p in predicted
            )

            lang_tp += len(gold_spans & pred_spans)
            lang_fp += len(pred_spans - gold_spans)
            lang_fn += len(gold_spans - pred_spans)

        precision = lang_tp / max(lang_tp + lang_fp, 1)
        recall = lang_tp / max(lang_tp + lang_fn, 1)
        f1 = 2 * precision * recall / max(precision + recall, 1e-9)
        f2 = (5 * precision * recall) / max(4 * precision + recall, 1e-9)

        per_locale[locale] = {
            "name": LOCALE_CONFIG[locale]["name"],
            "samples": len(locale_samples),
            "failures": failures,
            "tp": lang_tp,
            "fp": lang_fp,
            "fn": lang_fn,
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "f1": round(f1, 4),
            "f2": round(f2, 4),
        }

        total_tp += lang_tp
        total_fp += lang_fp
        total_fn += lang_fn

        print(
            f"  {locale} ({LOCALE_CONFIG[locale]['name']}): "
            f"P={precision:.3f} R={recall:.3f} F1={f1:.3f} F2={f2:.3f}"
        )

    # Aggregated
    total_precision = total_tp / max(total_tp + total_fp, 1)
    total_recall = total_tp / max(total_tp + total_fn, 1)
    total_f1 = 2 * total_precision * total_recall / max(total_precision + total_recall, 1e-9)
    total_f2 = (5 * total_precision * total_recall) / max(4 * total_precision + total_recall, 1e-9)

    results = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "seed": seed,
        "locales": locales,
        "total_samples": len(dataset),
        "aggregate": {
            "precision": round(total_precision, 4),
            "recall": round(total_recall, 4),
            "f1": round(total_f1, 4),
            "f2": round(total_f2, 4),
        },
        "per_locale": per_locale,
    }

    print(f"\n  Aggregate: P={total_precision:.3f} R={total_recall:.3f} F1={total_f1:.3f} F2={total_f2:.3f}")

    # Save results
    os.makedirs(output_dir, exist_ok=True)
    results_path = os.path.join(output_dir, "latest.json")
    with open(results_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nResults saved → {results_path}")

    # Generate Markdown report
    _generate_cross_lingual_report(results, output_dir)

    return results


def _generate_cross_lingual_report(results: Dict[str, Any], output_dir: str) -> None:
    """Generate Markdown report for cross-lingual results."""
    lines: List[str] = []
    lines.append("# Cross-Lingual PII Detection Results")
    lines.append("")
    lines.append(f"**Generated:** {results['timestamp']}")
    lines.append(f"**Locales:** {', '.join(results['locales'])}")
    lines.append(f"**Total Samples:** {results['total_samples']}")
    lines.append(f"**Seed:** {results['seed']}")
    lines.append("")

    agg = results["aggregate"]
    lines.append("## Aggregate Results")
    lines.append("")
    lines.append("| Metric | Value |")
    lines.append("|--------|-------|")
    lines.append(f"| **Precision** | {agg['precision']:.4f} |")
    lines.append(f"| **Recall** | {agg['recall']:.4f} |")
    lines.append(f"| **F₁** | {agg['f1']:.4f} |")
    lines.append(f"| **F₂ (β=2)** | {agg['f2']:.4f} |")
    lines.append("")

    lines.append("## Per-Locale Breakdown")
    lines.append("")
    lines.append("| Locale | Samples | Precision | Recall | F₁ | F₂ | Failures |")
    lines.append("|--------|---------|-----------|--------|-----|-----|----------|")

    for locale, data in results["per_locale"].items():
        lines.append(
            f"| {locale} ({data['name']}) | {data['samples']} | "
            f"{data['precision']:.4f} | {data['recall']:.4f} | "
            f"{data['f1']:.4f} | {data['f2']:.4f} | {data['failures']} |"
        )
    lines.append("")

    lines.append("## Methodology")
    lines.append("")
    lines.append("- Synthetic data generated with stdlib-only generator (no external deps)")
    lines.append("- Each locale uses culturally appropriate names, orgs, addresses, phone formats, date formats")
    lines.append("- Entity types evaluated: PERSON, ORGANIZATION, EMAIL_ADDRESS, PHONE_NUMBER, IP_ADDRESS, DATE_TIME, LOCATION, CREDIT_CARD")
    lines.append("- Evaluation via `/analyze` endpoint with locale-specific `language` parameter")
    lines.append("- Span matching: exact (entity_type + start + end)")
    lines.append("")

    report_path = os.path.join(output_dir, "CROSS_LINGUAL_RESULTS.md")
    with open(report_path, "w") as f:
        f.write("\n".join(lines))
    print(f"Report saved → {report_path}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Cross-Lingual PII Detection Benchmark",
    )
    parser.add_argument(
        "--locales",
        default="en_US,de_DE,fr_FR,es_MX",
        help="Comma-separated locale codes (default: en_US,de_DE,fr_FR,es_MX)",
    )
    parser.add_argument("--num-samples", type=int, default=200)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--service-url",
        default="http://localhost:3000/analyze",
    )
    parser.add_argument(
        "--output-dir",
        default="benchmarks/cross_lingual/results",
    )
    args = parser.parse_args()

    locales = [l.strip() for l in args.locales.split(",")]
    evaluate_cross_lingual(
        service_url=args.service_url,
        locales=locales,
        num_samples=args.num_samples,
        seed=args.seed,
        output_dir=args.output_dir,
    )


if __name__ == "__main__":
    main()
