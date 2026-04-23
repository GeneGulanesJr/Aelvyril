"""
Shared benchmark utilities.
"""

from __future__ import annotations

import random
from typing import List

import numpy as np


def set_seeds(seed: int = 42) -> None:
    """Set all random seeds for reproducibility."""
    random.seed(seed)
    np.random.seed(seed)


def load_test_samples(path: str) -> List[dict]:
    """Load test samples from a JSON file.

    Expected format: list of {"text": "...", "spans": [{"entity_type", "start", "end"}, ...]}
    """
    import json

    with open(path) as f:
        return json.load(f)
