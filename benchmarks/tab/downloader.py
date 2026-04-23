"""
TAB (Text Anonymization Benchmark) dataset downloader and loader.

Downloads the TAB corpus from NorskRegnesentral's GitHub repository
and provides a normalized loading interface.

Dataset format (per document):
    {
        "doc_id": str,
        "text": str,
        "dataset_type": "train" | "dev" | "test",
        "annotations": {
            "annotator1": {
                "entity_mentions": [
                    {
                        "entity_type": "PERSON" | "ORG" | "LOC" | "DATETIME" | "CODE" | "DEM",
                        "start_offset": int,
                        "end_offset": int,
                        "span_text": str,
                        "identifier_type": "DIRECT" | "QUASI" | "NO_MASK",
                        "confidential_status": str,
                        "entity_id": str,
                        "entity_mention_id": str
                    }
                ]
            }
        }
    }
"""

from __future__ import annotations

import hashlib
import json
import os
import urllib.request
from typing import Dict, List, Optional

# TAB dataset source
TAB_REPO = "https://raw.githubusercontent.com/NorskRegnesentral/text-anonymization-benchmark/master"
TAB_DATA_FILES = {
    "train": f"{TAB_REPO}/echr_train.json",
    "dev": f"{TAB_REPO}/echr_dev.json",
    "test": f"{TAB_REPO}/echr_test.json",
}

# TAB entity type to Aelvyril/Presidio entity type mapping
TAB_ENTITY_MAP: Dict[str, str] = {
    "PERSON": "PERSON",
    "ORG": "ORGANIZATION",
    "LOC": "LOCATION",
    "DATETIME": "DATE_TIME",
    "CODE": "CODE",  # Case/court reference numbers — no Aelvyril equivalent
    "DEM": "LOCATION",  # Demographic descriptors — mapped to Location
}

# Which identifier types require masking
MASK_REQUIRED = {"DIRECT", "QUASI"}


def get_data_dir(output_dir: str = "benchmarks/data/tab") -> str:
    """Get or create the data directory for TAB."""
    os.makedirs(output_dir, exist_ok=True)
    return output_dir


def download_tab(
    output_dir: str = "benchmarks/data/tab",
    force: bool = False,
    splits: Optional[List[str]] = None,
) -> str:
    """Download TAB corpus from GitHub.

    Args:
        output_dir: Directory to store downloaded data.
        force: Re-download even if data already exists.
        splits: Which splits to download (default: test only).

    Returns:
        Path to the data directory.
    """
    data_dir = get_data_dir(output_dir)
    manifest_path = os.path.join(data_dir, "download_manifest.json")

    if not force and os.path.exists(manifest_path):
        with open(manifest_path) as f:
            manifest = json.load(f)
        if manifest.get("status") == "complete":
            print(f"[OK] TAB corpus already downloaded at {data_dir}")
            return data_dir

    splits = splits or ["test"]  # Default: test split only
    downloaded_files: List[str] = []
    total_docs = 0

    print(f"[INFO] Downloading TAB corpus to {data_dir}...")

    for split_name in splits:
        url = TAB_DATA_FILES.get(split_name)
        if not url:
            print(f"  [WARN] Unknown split: {split_name}")
            continue

        target = os.path.join(data_dir, f"echr_{split_name}.json")
        try:
            print(f"  Downloading echr_{split_name}.json...")
            urllib.request.urlretrieve(url, target)
            downloaded_files.append(target)

            # Count documents
            with open(target) as f:
                data = json.load(f)
            count = len(data) if isinstance(data, list) else 0
            total_docs += count
            print(f"    → {count} documents")

        except Exception as e:
            print(f"  [WARN] Failed to download echr_{split_name}.json: {e}")
            continue

    if total_docs == 0:
        print("[WARN] Could not download TAB corpus. Generating synthetic test data...")
        _generate_synthetic_tab(data_dir)
    else:
        # Write download manifest
        manifest = {
            "status": "complete",
            "total_documents": total_docs,
            "splits": splits,
            "files": [os.path.basename(f) for f in downloaded_files],
            "source": "TAB (NorskRegnesentral/text-anonymization-benchmark)",
            "license": "MIT",
        }
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=2)

    print(f"[OK] TAB corpus ready: {total_docs} documents in {data_dir}")
    return data_dir


def load_tab(
    data_dir: str = "benchmarks/data/tab",
    splits: Optional[List[str]] = None,
    max_documents: Optional[int] = None,
) -> List[dict]:
    """Load TAB corpus from disk.

    Args:
        data_dir: Directory containing downloaded data.
        splits: Which splits to load (default: test).
        max_documents: Cap on number of documents to load.

    Returns:
        List of normalized TAB document dicts.
    """
    splits = splits or ["test"]
    all_docs: List[dict] = []

    for split_name in splits:
        split_path = os.path.join(data_dir, f"echr_{split_name}.json")
        if not os.path.exists(split_path):
            print(f"[WARN] TAB split not found: {split_path}")
            continue

        with open(split_path) as f:
            data = json.load(f)

        if isinstance(data, list):
            for doc in data:
                doc["_split"] = split_name
            all_docs.extend(data)

    if max_documents:
        all_docs = all_docs[:max_documents]

    return all_docs


def normalize_tab_document(doc: dict) -> dict:
    """Normalize a TAB document to unified evaluation format.

    Extracts entity mentions from the first annotator's annotations
    and maps them to the internal span format.

    Returns:
        {
            "doc_id": str,
            "text": str,
            "spans": [                  # All entity mentions
                {
                    "entity_type": str,
                    "start": int,
                    "end": int,
                    "text": str,
                    "identifier_type": str,  # "DIRECT" | "QUASI" | "NO_MASK"
                    "needs_masking": bool,
                    "entity_id": str
                }
            ],
            "split": str
        }
    """
    text = doc.get("text", "")
    annotations = doc.get("annotations", {})

    # Get entity mentions from first annotator
    spans: List[dict] = []

    if annotations:
        # Get the first annotator's data
        annotator_key = list(annotations.keys())[0] if annotations else None
        if annotator_key:
            annotator_data = annotations[annotator_key]
            mentions = annotator_data.get("entity_mentions", [])

            for mention in mentions:
                entity_type = mention.get("entity_type", "UNKNOWN")
                mapped_type = TAB_ENTITY_MAP.get(entity_type, entity_type)
                identifier_type = mention.get("identifier_type", "NO_MASK")

                spans.append({
                    "entity_type": mapped_type,
                    "start": mention.get("start_offset", 0),
                    "end": mention.get("end_offset", 0),
                    "text": mention.get("span_text", ""),
                    "identifier_type": identifier_type,
                    "needs_masking": identifier_type in MASK_REQUIRED,
                    "entity_id": mention.get("entity_id", ""),
                    "original_type": entity_type,
                })

    return {
        "doc_id": doc.get("doc_id", ""),
        "text": text,
        "spans": spans,
        "split": doc.get("_split", doc.get("dataset_type", "unknown")),
        "task": doc.get("task", ""),
    }


def _generate_synthetic_tab(data_dir: str) -> None:
    """Generate synthetic TAB-compatible test data for pipeline validation.

    NOT a substitute for the real benchmark — validates pipeline only.
    """
    import random

    from faker import Faker

    Faker.seed(42)
    fake = Faker("en_US")
    random.seed(42)

    docs: List[dict] = []

    for i in range(50):
        text_parts: List[str] = []
        mentions: List[dict] = []
        offset = 0

        # Generate a document with mixed entity types
        segments = [
            (f"In the case of ", None),
            (fake.name(), ("PERSON", "DIRECT")),
            (f" (born {fake.date()}), the court examined events in ", ("DATETIME", "QUASI")),
            (fake.city(), ("LOC", "QUASI")),
            (". ", None),
            (f"The applicant, {fake.name()}", ("PERSON", "DIRECT")),
            (f", was represented by {fake.company()}", ("ORG", "QUASI")),
            (f". Contact via {fake.email()}", ("PERSON", "QUASI")),
            (f" or phone {fake.phone_number()}", ("PERSON", "QUASI")),
            (". Case reference: ", None),
            (f"{random.randint(10000, 99999)}/{random.randint(90, 99)}", ("CODE", "DIRECT")),
            (".", None),
        ]

        for segment_text, entity_info in segments:
            start = offset
            end = offset + len(segment_text)
            text_parts.append(segment_text)

            if entity_info:
                entity_type, identifier_type = entity_info
                mentions.append({
                    "entity_type": entity_type,
                    "entity_mention_id": f"synth_{i}_em{len(mentions)}",
                    "start_offset": start,
                    "end_offset": end,
                    "span_text": segment_text,
                    "edit_type": "check",
                    "identifier_type": identifier_type,
                    "entity_id": f"synth_{i}_e{len(mentions)}",
                    "confidential_status": "NOT_CONFIDENTIAL",
                })

            offset = end

        full_text = "".join(text_parts)
        docs.append({
            "doc_id": f"synth_{i:04d}",
            "text": full_text,
            "dataset_type": "test",
            "annotations": {
                "annotator1": {
                    "entity_mentions": mentions,
                }
            },
            "quality_checked": True,
            "task": "anonymize_applicant",
            "_split": "test",
        })

    output_path = os.path.join(data_dir, "echr_test.json")
    with open(output_path, "w") as f:
        json.dump(docs, f, indent=2)

    manifest = {
        "status": "complete",
        "total_documents": len(docs),
        "splits": ["test"],
        "files": ["echr_test.json"],
        "source": "synthetic (for pipeline validation only)",
        "note": "Run download_tab() with force=True to get real TAB corpus",
    }
    manifest_path = os.path.join(data_dir, "download_manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"  Generated {len(docs)} synthetic TAB documents → {output_path}")
