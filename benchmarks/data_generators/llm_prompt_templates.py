"""
LLM-prompt-specific synthetic PII data generator.

Generates realistic test samples mimicking LLM chat interactions, code snippets,
email bodies, and other contexts where Aelvyril operates.

Uses Faker for realistic PII values and template-based text generation.
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from faker import Faker

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
    """Generate LLM-context synthetic PII test data using Faker + templates."""

    def __init__(self, seed: int = 42, locale: str = "en_US"):
        self.fake = Faker(locale)
        Faker.seed(seed)
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
        return self.fake.email(), "EMAIL_ADDRESS"

    def _gen_phone(self) -> tuple[str, str]:
        return self.fake.phone_number(), "PHONE_NUMBER"

    def _gen_ssn(self) -> tuple[str, str]:
        return self.fake.ssn(), "US_SSN"

    def _gen_ip(self) -> tuple[str, str]:
        return self.fake.ipv4_public(), "IP_ADDRESS"

    def _gen_credit_card(self) -> tuple[str, str]:
        return self.fake.credit_card_number(), "CREDIT_CARD"

    def _gen_iban(self) -> tuple[str, str]:
        # Faker doesn't have IBAN directly, generate a plausible one
        country = random.choice(["GB", "DE", "FR", "ES", "IT"])
        check = f"{random.randint(10, 99)}"
        bban = "".join([str(random.randint(0, 9)) for _ in range(random.randint(14, 30))])
        return f"{country}{check}{bban}", "IBAN_CODE"

    def _gen_person(self) -> tuple[str, str]:
        return self.fake.name(), "PERSON"

    def _gen_location(self) -> tuple[str, str]:
        return self.fake.city(), "LOCATION"

    def _gen_organization(self) -> tuple[str, str]:
        return self.fake.company(), "ORGANIZATION"

    def _gen_api_key(self) -> tuple[str, str]:
        prefixes = ["sk", "sk-proj", "sk-ant", "sk-live"]
        prefix = random.choice(prefixes)
        key = "".join(random.choices("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", k=random.randint(24, 48)))  # noqa: E501
        return f"{prefix}-{key}", "API_KEY"

    def _gen_zip(self) -> tuple[str, str]:
        return self.fake.zipcode(), "US_ZIP_CODE"

    def _gen_date(self) -> tuple[str, str]:
        return self.fake.date(), "DATE_TIME"

    def _gen_street(self) -> tuple[str, str]:
        return self.fake.street_address(), "STREET_ADDRESS"

    def _gen_city(self) -> tuple[str, str]:
        return self.fake.city(), "CITY"

    def _gen_state(self) -> tuple[str, str]:
        return self.fake.state(), "LOCATION"

    def _gen_username(self) -> tuple[str, str]:
        return self.fake.user_name(), "PERSON"

    def _gen_message(self) -> tuple[str, str]:
        return self.fake.sentence(), "TEXT"

    def _gen_question(self) -> tuple[str, str]:
        return self.fake.sentence() + "?", "TEXT"

    def _gen_condition(self) -> tuple[str, str]:
        return self.fake.sentence(), "TEXT"

    def _gen_invoice(self) -> tuple[str, str]:
        return str(random.randint(10000, 99999)), "TEXT"

    def generate_sample(self, template: str | None = None) -> SyntheticSample:
        """Generate a single synthetic sample from a template."""
        if template is None:
            template = random.choice(LLM_PROMPT_TEMPLATES)

        text = template
        spans: List[Dict] = []

        # Find all placeholders and replace them
        for placeholder, gen_fn in self._template_pii_map.items():
            if placeholder not in text:
                continue

            value, entity_type = gen_fn()
            # Skip non-PII types for span tracking
            if entity_type == "TEXT":
                text = text.replace(placeholder, value, 1)
                continue

            # Replace and track span
            idx = text.find(placeholder)
            text = text.replace(placeholder, value, 1)
            spans.append({
                "entity_type": entity_type,
                "start": idx,
                "end": idx + len(value),
                "text": value,
            })

        return SyntheticSample(text=text, spans=spans)

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
            template = random.choice(templates)
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
