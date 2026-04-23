"""
Adversarial text perturbations for PII detection robustness testing.

Implements a suite of character-level, word-level, and syntactic perturbations
designed to evade PII detection while preserving semantic meaning:

1. Character-level: leet speak, homoglyph substitution, zero-width insertion
2. Word-level: synonym replacement, passive voice transformation
3. Syntactic: sentence reordering, punctuation manipulation
4. Contextual: PII embedding in code blocks, markdown, HTML

Reference: "PII Leakage in NLP" (Huang et al., 2022) and
           "Adversarial NER" (Ebrahimi et al., 2018)
"""

from __future__ import annotations

import random
import re
import string
from typing import Callable, Dict, List, Optional, Tuple


PerturbFn = Callable[[str, random.Random], str]


# ── Character-level Perturbations ──────────────────────────────────────────────

LEET_MAP: Dict[str, str] = {
    "a": "@", "e": "3", "i": "1", "o": "0", "s": "$", "t": "7",
    "l": "1", "g": "9", "b": "8", "z": "2",
}

HOMOGLYPHS: Dict[str, List[str]] = {
    "a": ["а"],  # Cyrillic а
    "e": ["е"],  # Cyrillic е
    "o": ["о"],  # Cyrillic о
    "p": ["р"],  # Cyrillic р
    "c": ["с"],  # Cyrillic с
    "x": ["х"],  # Cyrillic х
    "y": ["у"],  # Cyrillic у
    ".": ["․"],  # One dot leader
    "-": ["‐", "‑"],  # Hyphen variants
}


def leet_speak(text: str, rng: random.Random, prob: float = 0.3) -> str:
    """Replace characters with leet speak equivalents."""
    result = []
    for ch in text:
        if ch.lower() in LEET_MAP and rng.random() < prob:
            result.append(LEET_MAP[ch.lower()])
        else:
            result.append(ch)
    return "".join(result)


def homoglyph_substitution(text: str, rng: random.Random, prob: float = 0.2) -> str:
    """Replace ASCII characters with visually identical Unicode homoglyphs."""
    result = []
    for ch in text:
        if ch in HOMOGLYPHS and rng.random() < prob:
            result.append(rng.choice(HOMOGLYPHS[ch]))
        else:
            result.append(ch)
    return "".join(result)


def zero_width_insertion(text: str, rng: random.Random, prob: float = 0.15) -> str:
    """Insert zero-width characters between letters to break tokenization."""
    zws = "​"  # Zero-width space
    zwj = "‍"  # Zero-width joiner
    result = []
    for ch in text:
        result.append(ch)
        if ch.isalnum() and rng.random() < prob:
            result.append(rng.choice([zws, zwj]))
    return "".join(result)


def insert_invisible_spaces(text: str, rng: random.Random, prob: float = 0.1) -> str:
    """Insert zero-width non-joiner between characters."""
    zwnj = "‌"
    return zwnj.join(c if rng.random() > prob else c + zwnj for c in text)


# ── Word-level Perturbations ───────────────────────────────────────────────────

EMAIL_OBFUSCATIONS: List[Callable[[str, random.Random], str]] = [
    lambda t, r: t.replace("@", " [at] "),
    lambda t, r: t.replace("@", "(at)"),
    lambda t, r: t.replace("@", " AT "),
    lambda t, r: t.replace(".", " [dot] "),
    lambda t, r: t.replace(".", "(dot)"),
    lambda t, r: " ".join(t),  # j o h n @ e x a m p l e . c o m
]

PHONE_OBFUSCATIONS: List[Callable[[str, random.Random], str]] = [
    lambda t, r: t.replace("-", " "),
    lambda t, r: t.replace("-", "."),
    lambda t, r: " ".join(c for c in t if c.isdigit()),
    lambda t, r: f"({t[:3]}) {t[4:7]}-{t[8:]}",  # Already standard, but as test
]


def obfuscate_email(text: str, rng: random.Random) -> str:
    """Apply random email obfuscation technique."""
    fn = rng.choice(EMAIL_OBFUSCATIONS)
    return fn(text, rng)


def obfuscate_phone(text: str, rng: random.Random) -> str:
    """Apply random phone obfuscation technique."""
    fn = rng.choice(PHONE_OBFUSCATIONS)
    return fn(text, rng)


def synonym_replacement(text: str, rng: random.Random, prob: float = 0.1) -> str:
    """Simple synonym replacement for common words (limited vocabulary)."""
    synonyms: Dict[str, List[str]] = {
        "email": ["e-mail", "electronic mail", "mail address"],
        "phone": ["telephone", "cell", "mobile", "number"],
        "address": ["location", "residence", "place"],
        "name": ["identity", "moniker", "full name"],
        "contact": ["reach", "get in touch", "connect"],
        "send": ["transmit", "dispatch", "forward"],
        "call": ["phone", "ring", "dial"],
        "number": ["digits", "code", "identifier"],
    }
    words = text.split()
    result = []
    for w in words:
        lower = w.lower().strip(string.punctuation)
        if lower in synonyms and rng.random() < prob:
            replacement = rng.choice(synonyms[lower])
            # Preserve case and punctuation roughly
            if w[0].isupper():
                replacement = replacement.capitalize()
            result.append(replacement)
        else:
            result.append(w)
    return " ".join(result)


# ── Contextual / Syntactic Perturbations ───────────────────────────────────────

CODE_BLOCK_WRAPPERS = [
    lambda t: f"```\n{t}\n```",
    lambda t: f"`<code>{t}</code>`",
    lambda t: f"`{t}`",
]

HTML_WRAPPERS = [
    lambda t: f"<span>{t}</span>",
    lambda t: f"<div class=\"info\">{t}</div>",
    lambda t: f"<p>{t}</p>",
]


def wrap_in_code_block(text: str, rng: random.Random) -> str:
    """Wrap PII in markdown code blocks to test context-aware detection."""
    fn = rng.choice(CODE_BLOCK_WRAPPERS)
    return fn(text)


def wrap_in_html(text: str, rng: random.Random) -> str:
    """Wrap PII in HTML tags."""
    fn = rng.choice(HTML_WRAPPERS)
    return fn(text)


def insert_typos(text: str, rng: random.Random, prob: float = 0.1) -> str:
    """Insert random typos (character swaps, deletions, duplications)."""
    chars = list(text)
    for i in range(len(chars) - 1):
        if rng.random() < prob:
            op = rng.choice(["swap", "delete", "dup"])
            if op == "swap" and i < len(chars) - 1:
                chars[i], chars[i + 1] = chars[i + 1], chars[i]
            elif op == "delete":
                chars[i] = ""
            elif op == "dup":
                chars[i] = chars[i] * 2
    return "".join(chars)


def add_filler_words(text: str, rng: random.Random, prob: float = 0.05) -> str:
    """Insert filler words between tokens to break patterns."""
    fillers = ["um", "like", "basically", "you know", "sort of", "kind of"]
    words = text.split()
    result = []
    for w in words:
        result.append(w)
        if rng.random() < prob:
            result.append(rng.choice(fillers))
    return " ".join(result)


# ── Attack Registry ────────────────────────────────────────────────────────────

class AttackRegistry:
    """Registry of all adversarial perturbation functions."""

    ATTACKS: Dict[str, PerturbFn] = {
        "leet_speak": leet_speak,
        "homoglyph": homoglyph_substitution,
        "zero_width": zero_width_insertion,
        "invisible_spaces": insert_invisible_spaces,
        "typo": insert_typos,
        "synonym": synonym_replacement,
        "filler_words": add_filler_words,
        "code_block": wrap_in_code_block,
        "html_wrap": wrap_in_html,
    }

    @classmethod
    def list_attacks(cls) -> List[str]:
        return list(cls.ATTACKS.keys())

    @classmethod
    def get(cls, name: str) -> PerturbFn:
        if name not in cls.ATTACKS:
            raise ValueError(f"Unknown attack: {name}. Available: {cls.list_attacks()}")
        return cls.ATTACKS[name]

    @classmethod
    def apply(cls, text: str, attack_name: str, seed: int = 42, **kwargs) -> str:
        rng = random.Random(seed)
        fn = cls.get(attack_name)
        return fn(text, rng, **kwargs) if kwargs else fn(text, rng)


def apply_all_attacks(text: str, seed: int = 42) -> Dict[str, str]:
    """Apply all registered attacks to a text and return a mapping."""
    rng = random.Random(seed)
    results: Dict[str, str] = {}
    for name, fn in AttackRegistry.ATTACKS.items():
        try:
            results[name] = fn(text, rng)
        except Exception as e:
            results[name] = f"[ERROR: {e}]"
    return results
