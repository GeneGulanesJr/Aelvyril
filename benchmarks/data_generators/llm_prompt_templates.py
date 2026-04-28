"""
LLM-prompt-specific synthetic PII data generator.

Generates realistic test samples mimicking LLM chat interactions, code snippets,
email bodies, and other contexts where Aelvyril operates.

Uses stdlib random for realistic PII values and template-based text generation.
"""

from __future__ import annotations

import json
import random
import string
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from benchmarks.common.synthetic_pii import (
    _random_address,
    _random_city,
    _random_company,
    _random_credit_card,
    _random_date,
    _random_domain,
    _random_email,
    _random_ip,
    _random_name,
    _random_password,
    _random_phone,
    _random_ssn,
    _random_username,
    _random_zipcode,
    _random_iban,
)
from benchmarks.common.utils import set_seeds


# ── LLM Prompt Templates ────────────────────────────────────────────────────────

LLM_PROMPT_TEMPLATES = [
    "User asked: {question} and provided SSN: {ssn}",
    "Customer email: {email} with credit card {credit_card}",
    "Debug log: user {person} from {location} connected via {ip}",
    "Chat: @{username} sent phone {phone} in message: {message}",
    "Please ship to {person} at {street_address}, {city}, {state} {zip_code}",
    "API call from {ip} with key {api_key} returned user {email}",
    "Patient {person} (DOB: {date}) SSN: {ssn} — diagnosis: {condition}",
    "Wire transfer: {iban} from {organization} to {person}",
    "Server log: {ip} - - [{date}] GET /api/users/{email}",
    "Support ticket: {person} reports issue from {location}. Phone: {phone}",
    "Meeting invite: {person} ({email}) at {location} on {date}",
    "Code review comment: @{username} your API key {api_key} is exposed in line 42",
    "Resume excerpt: {person}, {organization}, {street_address}, {phone}, {email}",
    "Chat message: my new number is {phone}, email me at {email}",
    "Error report from {ip}: user {person} account {email} failed validation",
    "Invoice #{invoice_num} for {organization} — billing: {credit_card}",
    "Database record: name={person}, ssn={ssn}, address={street_address}",
    "Notification: {person} from {organization} joined from {location}",
    "Config file: database_host={ip}, admin_email={email}, secret={api_key}",
    "Contact update: {person} moved to {location}. New zip: {zip_code}",
]


@dataclass
class SyntheticSample:
    """A single synthetic test sample with ground-truth PII spans."""

    text: str
    spans: List[Dict]  # [{"entity_type": str, "start": int, "end": int, "text": str}]


class LLMPromptDataGenerator:
    """Generate LLM-context synthetic PII test data using templates."""

    def __init__(self, seed: int = 42, locale: str = "en_US"):
        self.rng = random.Random(seed)
        set_seeds(seed)
        self._template_pii_map = {
            "{email}": self._gen_email,
            "{phone}": self._gen_phone,
            "{ssn}": self._gen_ssn,
            "{ip}": self._gen_ip,
            "{credit_card}": self._gen_credit_card,
            "{iban}": self._gen_iban,
            "{person}": self._gen_person,
            "{location}": self._gen_location,
            "{organization}": self._gen_organization,
            "{api_key}": self._gen_api_key,
            "{zip_code}": self._gen_zip,
            "{date}": self._gen_date,
            "{street_address}": self._gen_street,
            "{city}": self._gen_city,
            "{state}": self._gen_state,
            "{username}": self._gen_username,
            "{message}": self._gen_message,
            "{question}": self._gen_question,
            "{condition}": self._gen_condition,
            "{invoice_num}": self._gen_invoice,
        }

    def _gen_email(self) -> tuple[str, str]:
        return _random_email(self.rng), "EMAIL_ADDRESS"

    def _gen_phone(self) -> tuple[str, str]:
        return _random_phone(self.rng), "PHONE_NUMBER"

    def _gen_ssn(self) -> tuple[str, str]:
        return _random_ssn(self.rng), "US_SSN"

    def _gen_ip(self) -> tuple[str, str]:
        return _random_ip(self.rng), "IP_ADDRESS"

    def _gen_credit_card(self) -> tuple[str, str]:
        return _random_credit_card(self.rng), "CREDIT_CARD"

    def _gen_iban(self) -> tuple[str, str]:
        return _random_iban(self.rng), "IBAN_CODE"

    def _gen_person(self) -> tuple[str, str]:
        return _random_name(self.rng), "PERSON"

    def _gen_location(self) -> tuple[str, str]:
        return _random_city(self.rng), "LOCATION"

    def _gen_organization(self) -> tuple[str, str]:
        return _random_company(self.rng), "ORGANIZATION"

    def _gen_api_key(self) -> tuple[str, str]:
        prefixes = ["sk", "sk-proj", "sk-ant", "sk-live"]
        prefix = self.rng.choice(prefixes)
        key = "".join(self.rng.choices(string.ascii_letters + string.digits, k=self.rng.randint(24, 48)))  # noqa: E501
        return f"{prefix}-{key}", "API_KEY"

    def _gen_zip(self) -> tuple[str, str]:
        return _random_zipcode(self.rng), "US_ZIP_CODE"

    def _gen_date(self) -> tuple[str, str]:
        return _random_date(self.rng), "DATE_TIME"

    def _gen_street(self) -> tuple[str, str]:
        return _random_address(self.rng), "STREET_ADDRESS"

    def _gen_city(self) -> tuple[str, str]:
        return _random_city(self.rng), "CITY"

    def _gen_state(self) -> tuple[str, str]:
        return self.rng.choice(["CA", "NY", "TX", "FL", "IL", "PA", "OH", "GA", "NC", "MI"]), "LOCATION"

    def _gen_username(self) -> tuple[str, str]:
        return _random_username(self.rng), "PERSON"

    def _gen_message(self) -> tuple[str, str]:
        phrases = [
            "I will be late to the meeting",
            "Can you send me the document",
            "The server is down again",
            "Please review my PR",
            "I need access to the database",
            "The client wants changes",
            "We should reschedule",
            "Thanks for your help",
            "Let me know when you are free",
            "I found a bug in production",
        ]
        return self.rng.choice(phrases), "TEXT"

    def _gen_question(self) -> tuple[str, str]:
        questions = [
            "How do I reset my password",
            "What is the status of my order",
            "Can you explain this charge",
            "Why was my account locked",
            "How do I update my billing info",
            "What are your business hours",
            "Can I get a refund",
            "How do I contact support",
            "Is my data secure",
            "What is your privacy policy",
        ]
        return self.rng.choice(questions) + "?", "TEXT"

    def _gen_condition(self) -> tuple[str, str]:
        conditions = [
            "migraine with aura",
            "seasonal allergies",
            "type 2 diabetes",
            "hypertension stage 1",
            "chronic back pain",
            "acute bronchitis",
            "anxiety disorder",
            "sprained ankle",
            "viral infection",
            "fractured wrist",
        ]
        return self.rng.choice(conditions), "TEXT"

    def _gen_invoice(self) -> tuple[str, str]:
        return str(self.rng.randint(10000, 99999)), "TEXT"

    def generate_sample(self, template: str | None = None) -> SyntheticSample:
        """Generate a single synthetic sample from a template."""
        if template is None:
            template = self.rng.choice(LLM_PROMPT_TEMPLATES)

        # Find all placeholder positions in the original template
        placeholders: List[tuple[str, int, int]] = []
        for placeholder in self._template_pii_map:
            start = 0
            while True:
                idx = template.find(placeholder, start)
                if idx == -1:
                    break
                placeholders.append((placeholder, idx, idx + len(placeholder)))
                start = idx + 1

        # Sort by start position to preserve order
        placeholders.sort(key=lambda x: x[1])

        # Generate replacement values
        replacements = []
        for placeholder, p_start, p_end in placeholders:
            value, entity_type = self._template_pii_map[placeholder]()
            replacements.append({
                "start": p_start,
                "end": p_end,
                "value": value,
                "entity_type": entity_type,
            })

        # Build final text and compute spans with correct offsets
        final_parts: List[str] = []
        last_idx = 0
        spans: List[Dict] = []

        for rep in replacements:
            # Append text before this placeholder
            final_parts.append(template[last_idx:rep["start"]])
            # Compute span start in final text
            span_start = sum(len(part) for part in final_parts)
            final_parts.append(rep["value"])
            span_end = span_start + len(rep["value"])
            if rep["entity_type"] != "TEXT":
                spans.append({
                    "entity_type": rep["entity_type"],
                    "start": span_start,
                    "end": span_end,
                    "text": rep["value"],
                })
            last_idx = rep["end"]

        # Append remainder
        final_parts.append(template[last_idx:])
        final_text = "".join(final_parts)

        return SyntheticSample(text=final_text, spans=spans)

    def generate_dataset(
        self,
        num_samples: int = 1000,
        templates: List[str] | None = None,
    ) -> List[SyntheticSample]:
        """Generate a full synthetic dataset.

        Args:
            num_samples: Number of samples to generate.
            templates: Optional list of templates (uses all defaults if None).

        Returns:
            List of SyntheticSample objects.
        """
        templates = templates or LLM_PROMPT_TEMPLATES
        samples: List[SyntheticSample] = []

        for _ in range(num_samples):
            template = self.rng.choice(templates)
            samples.append(self.generate_sample(template))

        return samples

    def save_dataset(
        self,
        samples: List[SyntheticSample],
        output_path: str,
    ) -> None:
        """Save generated dataset to JSON."""
        import os

        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        data = [
            {
                "text": s.text,
                "spans": s.spans,
            }
            for s in samples
        ]
        with open(output_path, "w") as f:
            json.dump(data, f, indent=2)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Generate synthetic PII test data")
    parser.add_argument("--num-samples", type=int, default=1000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", type=str, default="benchmarks/data/synthetic_llm_prompts.json")
    args = parser.parse_args()

    gen = LLMPromptDataGenerator(seed=args.seed)
    samples = gen.generate_dataset(args.num_samples)
    gen.save_dataset(samples, args.output)
    print(f"Generated {len(samples)} samples → {args.output}")
