#!/usr/bin/env python3
"""
Benchmark runner: evaluate our Presidio service and baseline models on standard NER
datasets (CoNLL-2003, etc.).

Usage
-----
    python benchmarks/benchmark_sota.py --dataset conll2003 --data-dir benchmarks/data/conll2003 --baselines presidio,spacy --limit 100

Baselines
---------
- presidio : our enhanced Aelvyril Presidio service (HTTP at http://localhost:5000)
- spacy    : vanilla spaCy en_core_web_lg model
- flair    : Flair NER (requires flair; pip install flair)
"""

import argparse, json, os, sys, time
from collections import defaultdict
from pathlib import Path

# ── Dataset loading ──────────────────────────────────────────────────────────

def load_conll2003(data_dir: str, limit: int = None):
    """Load CoNLL-2003 test data from `data_dir/test.txt`."""
    test_path = Path(data_dir) / "test.txt"
    if not test_path.exists():
        raise FileNotFoundError(f"CoNLL-2003 test file not found at {test_path}. Please download and place it there.")

    examples = []
    tokens, tags = [], []
    with open(test_path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if line == "" or line.startswith("-DOCSTART-"):
                if tokens:
                    examples.append({"tokens": tokens, "ner_tags": tags})
                    tokens, tags = [], []
                    if limit is not None and len(examples) >= limit:
                        break
                continue
            parts = line.split()
            if len(parts) < 4:
                continue  # malformed
            tokens.append(parts[0])
            tags.append(parts[-1])  # NER tag is last column
    if tokens:
        examples.append({"tokens": tokens, "ner_tags": tags})
    return examples

# ── Conversion utilities ────────────────────────────────────────────────────

# Mapping from dataset-specific tags
CONLL_MAP = {"PER": "PERSON", "LOC": "LOCATION", "ORG": "ORGANIZATION", "MISC": "MISC"}
TARGET_TYPES = {"PERSON", "LOCATION", "ORGANIZATION"}

def iob_to_spans(tokens, ner_tags):
    """Convert tokens + IOB tags to character-level spans (start, end, label)."""
    # Build text with single spaces
    text = " ".join(tokens)
    # Compute token start/end character offsets
    starts, ends = [], []
    idx = 0
    for tok in tokens:
        starts.append(idx)
        ends.append(idx + len(tok))
        idx += len(tok) + 1  # +1 for space
    # Build spans
    gold = []
    cur_label = None
    cur_start = None
    for i, tag in enumerate(ner_tags):
        prefix, _, label = tag.partition("-")
        label = CONLL_MAP.get(label, label)
        if prefix == "O":
            if cur_label is not None:
                gold.append({"start": cur_start, "end": ends[i-1], "label": cur_label})
                cur_label = None
            continue
        if prefix == "B":
            if cur_label is not None:
                gold.append({"start": cur_start, "end": ends[i-1], "label": cur_label})
            cur_label = label
            cur_start = starts[i]
        elif prefix == "I":
            if cur_label is None or label != cur_label:
                # Implicit start of a new entity
                if cur_label is not None:
                    gold.append({"start": cur_start, "end": ends[i-1], "label": cur_label})
                cur_label = label
                cur_start = starts[i]
            # else continue current
        # else ignore
    if cur_label is not None:
        gold.append({"start": cur_start, "end": ends[-1], "label": cur_label})
    # Filter to target types only
    gold = [s for s in gold if s["label"] in TARGET_TYPES]
    return text, gold

# ── Baseline predictors ──────────────────────────────────────────────────────

def baseline_presidio(text, service_url="http://localhost:5000"):
    """Call the Aelvyril Presidio HTTP service."""
    import requests
    resp = requests.post(f"{service_url}/analyze", json={"text": text, "language": "en", "score_threshold": 0.0}, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    preds = []
    for r in data.get("result", []):
        lbl = r["entity_type"]
        if lbl in TARGET_TYPES:
            preds.append({"start": r["start"], "end": r["end"], "label": lbl})
    return preds

def baseline_spacy(text):
    """Run vanilla spaCy model."""
    import spacy
    nlp = spacy.load("en_core_web_lg")
    doc = nlp(text)
    preds = []
    for ent in doc.ents:
        # Map spaCy labels
        if ent.label_ == "PERSON":
            lbl = "PERSON"
        elif ent.label_ in ("ORG", "ORGANIZATION"):
            lbl = "ORGANIZATION"
        elif ent.label_ in ("GPE", "LOC", "LOCATION"):
            lbl = "LOCATION"
        else:
            continue
        preds.append({"start": ent.start_char, "end": ent.end_char, "label": lbl})
    return preds

def baseline_flair(text):
    """Run Flair NER (placeholder)."""
    try:
        from flair.models import SequenceTagger
        from flair.data import Sentence
    except ImportError:
        print("Flair not installed; skipping.", file=sys.stderr)
        return []
    # Load model once globally ideally; for simplicity, load each time (slow)
    tagger = SequenceTagger.load("ner")
    sentence = Sentence(text)
    tagger.predict(sentence)
    preds = []
    for entity in sentence.get_spans("ner"):
        label = entity.get_label().value
        # Map: PER->PERSON, LOC->LOCATION, ORG->ORGANIZATION, MISC->?
        if label == "PER":
            lbl = "PERSON"
        elif label == "ORG":
            lbl = "ORGANIZATION"
        elif label == "LOC":
            lbl = "LOCATION"
        elif label == "MISC":
            lbl = "MISC"
        else:
            continue
        preds.append({"start": entity.start_position, "end": entity.end_position, "label": lbl})
    return preds

BASELINES = {
    "presidio": baseline_presidio,
    "spacy":    baseline_spacy,
    "flair":    baseline_flair,
}

# ── Metrics computation ───────────────────────────────────────────────────────

def compute_metrics(examples):
    """
    examples: list of dict {text, gold: [...], preds: {baseline: [...]}}
    Returns nested dict: metrics[baseline][entity] = {p,r,f1,support}
    """
    tp = defaultdict(lambda: defaultdict(int))
    fp = defaultdict(lambda: defaultdict(int))
    fn = defaultdict(lambda: defaultdict(int))

    for ex in examples:
        gold_spans = {(s["start"], s["end"], s["label"]) for s in ex["gold"]}
        for base_name, preds in ex["preds"].items():
            pred_spans = {(p["start"], p["end"], p["label"]) for p in preds}
            for span in pred_spans:
                if span in gold_spans:
                    tp[base_name][span[2]] += 1
                else:
                    fp[base_name][span[2]] += 1
            for span in gold_spans:
                if span not in pred_spans:
                    fn[base_name][span[2]] += 1

    metrics = {}
    for base in BASELINES.keys():
        metrics[base] = {}
        all_labels = set()
        for d in (tp[base], fp[base], fn[base]):
            all_labels.update(d.keys())
        for lbl in sorted(all_labels):
            t = tp[base][lbl]
            f_p = fp[base][lbl]
            f_n = fn[base][lbl]
            p = t / (t + f_p) if (t + f_p) > 0 else 0.0
            r = t / (t + f_n) if (t + f_n) > 0 else 0.0
            f1 = (2 * p * r / (p + r)) if (p + r) > 0 else 0.0
            metrics[base][lbl] = {"precision": p, "recall": r, "f1": f1, "support": t + f_n}
        # macro avg
        precisions = [v["precision"] for v in metrics[base].values()]
        recalls = [v["recall"] for v in metrics[base].values()]
        macro_p = sum(precisions) / len(precisions) if precisions else 0.0
        macro_r = sum(recalls) / len(recalls) if recalls else 0.0
        macro_f1 = (2 * macro_p * macro_r / (macro_p + macro_r)) if (macro_p + macro_r) > 0 else 0.0
        metrics[base]["macro_avg"] = {"precision": macro_p, "recall": macro_r, "f1": macro_f1}
    return metrics

# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Run NER benchmark on standard datasets")
    parser.add_argument("--dataset", choices=["conll2003"], required=True, help="Dataset name")
    parser.add_argument("--data-dir", default="benchmarks/data", help="Directory containing dataset files")
    parser.add_argument("--baselines", default="presidio,spacy", help="Comma-separated list of baselines")
    parser.add_argument("--limit", type=int, default=None, help="Maximum number of examples to evaluate")
    parser.add_argument("--output", default="benchmarks/results/sota_benchmark.json", help="Output JSON report")
    parser.add_argument("--service-url", default="http://localhost:5000", help="Presidio service URL")
    parser.add_argument("--download", action="store_true", help="Download CoNLL-2003 data if missing")
    args = parser.parse_args()

    # Auto-download CoNLL-2003 if requested and missing
    if args.dataset == "conll2003" and args.download:
        data_dir = Path(args.data_dir)
        test_file = data_dir / "test.txt"
        if not test_file.exists():
            print("Downloading CoNLL-2003 dataset...")
            import requests, tarfile, io
            url = "https://www.clips.uantwerpen.be/conll2003/ner.tgz"
            resp = requests.get(url, stream=True, timeout=60)
            resp.raise_for_status()
            tgz = tarfile.open(fileobj=io.BytesIO(resp.content), mode="r:gz")
            tgz.extractall(path=data_dir)
            print(f"Extracted to {data_dir}")
        else:
            print("CoNLL-2003 data already present.")

    # Load data
    print(f"Loading {args.dataset} from {args.data_dir} ...")
    examples_raw = load_conll2003(args.data_dir, limit=args.limit)
    print(f"Loaded {len(examples_raw)} examples")

    # Convert to text + gold spans, also keep tokens maybe for debugging
    examples = []
    for raw in examples_raw:
        text, gold = iob_to_spans(raw["tokens"], raw["ner_tags"])
        examples.append({"text": text, "gold": gold})

    # Prepare baselines selection
    selected = [s.strip() for s in args.baselines.split(",") if s.strip() in BASELINES]
    if not selected:
        print("No valid baselines selected.", file=sys.stderr)
        sys.exit(1)

    # Predict per baseline
    for ex in examples:
        ex["preds"] = {}
        for base in selected:
            try:
                if base == "presidio":
                    preds = baseline_presidio(ex["text"], service_url=args.service_url)
                elif base == "spacy":
                    preds = baseline_spacy(ex["text"])
                elif base == "flair":
                    preds = baseline_flair(ex["text"])
                else:
                    preds = []
                ex["preds"][base] = preds
            except Exception as e:
                print(f"Error on baseline {base} for text {ex['text'][:30]}: {e}", file=sys.stderr)
                ex["preds"][base] = []

    # Compute metrics
    metrics = compute_metrics(examples)

    # Print summary table
    print("\n=== Benchmark Results ===")
    header = f"{'Entity':<15}" + "".join([f"{b:>12}" for b in selected])
    print(header)
    print("-" * len(header))
    # per-entity rows
    all_ents = set()
    for m in metrics.values():
        all_ents.update(k for k in m.keys() if k not in ("macro_avg",))
    for ent in sorted(all_ents):
        row = f"{ent:<15}"
        for base in selected:
            ent_metrics = metrics[base].get(ent, {"precision":0,"recall":0,"f1":0,"support":0})
            row += f"{ent_metrics['f1']*100:>7.1f}%  "
        print(row)
    # macro avg row
    row = f"{'MACRO AVG':<15}"
    for base in selected:
        m = metrics[base].get("macro_avg", {"f1":0})
        row += f"{m['f1']*100:>7.1f}%  "
    print(row)

    # Detailed JSON output
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump({
            "dataset": args.dataset,
            "baselines": selected,
            "num_examples": len(examples),
            "metrics": metrics,
        }, f, indent=2)
    print(f"\nDetailed results saved to {output_path}")

if __name__ == "__main__":
    main()
