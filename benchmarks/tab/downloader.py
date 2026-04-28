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

# TAB entity type → benchmark canonical namespace.
#
# TAB uses a simpler schema (PERSON, ORG, LOC, DATETIME, CODE, DEM).
# Fine-grained types map to their canonical equivalents; unrecognized
# types (like CODE for case/court references) pass through unchanged.

TAB_ENTITY_MAP: Dict[str, str] = {
    "PERSON": "PERSON",
    "ORG": "ORGANIZATION",
    "ORGANIZATION": "ORGANIZATION",
    "LOC": "LOCATION",
    "LOCATION": "LOCATION",
    "CITY": "CITY",
    "US_STATE": "US_STATE",
    "STREET_ADDRESS": "STREET_ADDRESS",
    "COUNTRY": "COUNTRY",
    "DATETIME": "DATE_TIME",
    "DATE": "DATE_TIME",
    # CODE = court/case reference numbers — no Aelvyril equivalent, pass through
    "CODE": "CODE",
    # DEM (demographic descriptors) → LOCATION for legal context
    "DEM": "LOCATION",
    # Remaining fine-grained
    "PER": "PERSON",
    "NRP": "ORGANIZATION",
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
        raise RuntimeError(
            "TAB corpus download failed (all URLs returned errors). "
            "The repository (github.com/NorskRegnesentral/text-anonymization-benchmark) "
            "may be temporarily unavailable.\n\n"
            "Options:\n"
            "  1. Retry later.\n"
            "  2. Download manually and place echr_test.json in "
            f"     {data_dir}/"
        )
    else:
        # Write download manifest
        manifest = {
            "status": "complete",
            "total_documents": total_docs,
            "splits": splits,
            "files": [os.path.basename(f) for f in downloaded_files],
            "source": "TAB (NorskRegnesentral/text-anonymization-benchmark)",
            "license": "MIT",
            "data_source": "real",
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


