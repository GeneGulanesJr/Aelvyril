#!/usr/bin/env python3
"""Minimal NER benchmark for Aelvyril Presidio service.

Evaluates on CoNLL-2003 (English) only for now.
Outputs JSON report to benchmarks/results/.
"""
import argparse, json, sys, time
from collections import defaultdict
from pathlib import Path

import requests
from datasets import load_dataset

# Mapping from CoNLL-2003 labels → Presidio entity types
CONLL_TO_PRESIDIO = {
    "PER": "PERSON",
    "LOC": "LOCATION",
    "ORG": "ORGANIZATION",
    "MISC": "NRP",
}
EVAL_ENTITIES = {"PERSON", "LOCATION", "ORGANIZATION", "NRP"}


def conll_tokens_to_text(tokens):
    """Reconstruct raw text from token list (space-separated)."""
    return " ".join(tokens)


def conll_tokens_to_spans(tokens, ner_tags, id2label):
    """Return list of (start_char, end_char, entity_type) spans."""
    spans = []
    current_start = None
    current_label = None

    pos = 0
    for token, tag_id in zip(tokens, ner_tags):
        label = id2label[tag_id]
        clean = label.replace("B-", "").replace("I-", "")

        if label.startswith("B-"):
            if current_start is not None:
                spans.append((current_start, pos, current_label))
            current_start = pos
            current_label = clean
        elif label.startswith("I-") and current_start is not None and clean == current_label:
            pass
        else:
            if current_start is not None:
                spans.append((current_start, pos, current_label))
            current_start = None
            current_label = None

        pos += len(token) + 1  # +1 for space between tokens

    if current_start is not None:
        spans.append((current_start, pos - 1, current_label))

    return spans


def predict(text: str, url: str):
    payload = {"text": text, "language": "en", "score_threshold": 0.0}
    r = requests.post(f"{url}/analyze", json=payload, timeout=30)
    r.raise_for_status()
    data = r.json()
    return [(s["start"], s["end"], s["entity_type"]) for s in data.get("result", [])]


def align(preds, golds):
    tp = defaultdict(int)
    fp = defaultdict(int)
    fn = defaultdict(int)

    pred_set = set(preds)
    gold_set = set(golds)

    for p in pred_set:
        _, _, plbl = p
        if p in gold_set:
            tp[plbl] += 1
        else:
            fp[plbl] += 1

    for g in gold_set:
        if g not in pred_set:
            fn[g[2]] += 1

    return tp, fp, fn


def metrics(tp, fp, fn):
    result = {}
    all_labels = sorted(set(tp) | set(fp) | set(fn))
    for lbl in all_labels:
        t, f, n = tp[lbl], fp[lbl], fn[lbl]
        p = t / (t + f) if (t + f) > 0 else 0.0
        r = t / (t + n) if (t + n) > 0 else 0.0
        f1 = 2 * p * r / (p + r) if (p + r) > 0 else 0.0
        result[lbl] = {"precision": p, "recall": r, "f1": f1, "support": t + n}

    total_tp = sum(tp.values())
    total_fp = sum(fp.values())
    total_fn = sum(fn.values())
    micro_p = total_tp / (total_tp + total_fp) if (total_tp + total_fp) > 0 else 0.0
    micro_r = total_tp / (total_tp + total_fn) if (total_tp + total_fn) > 0 else 0.0
    micro_f1 = 2 * micro_p * micro_r / (micro_p + micro_r) if (micro_p + micro_r) > 0 else 0.0
    result["macro_avg"] = {
        "precision": sum(v["precision"] for v in result.values()) / len(result),
        "recall": sum(v["recall"] for v in result.values()) / len(result),
        "f1": sum(v["f1"] for v in result.values()) / len(result),
    }
    result["micro_avg"] = {"precision": micro_p, "recall": micro_r, "f1": micro_f1}
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="conll2003")
    ap.add_argument("--split", default="test")
    ap.add_argument("--url", default="http://localhost:5000")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--output", default="benchmarks/results")
    args = ap.parse_args()

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Loading {args.dataset}[{args.split}]...")
    ds = load_dataset("conll2003", split=args.split)
    if args.limit > 0:
        ds = ds.select(range(min(args.limit, len(ds))))

    id2label = {v: k for k, v in ds.features["ner_tags"].feature.int2str.items()}

    tp, fp, fn = defaultdict(int), defaultdict(int), defaultdict(int)
    errors = []

    for idx, ex in enumerate(ds):
        tokens = ex["tokens"]
        text = " ".join(tokens)
        gold_spans_raw = conll_tokens_to_spans(tokens, ex["ner_tags"], id2label)
        gold = [(s, e, CONLL_TO_PRESIDIO[lbl]) for s, e, lbl in gold_spans_raw if lbl in CONLL_TO_PRESIDIO and CONLL_TO_PRESIDIO[lbl] in EVAL_ENTITIES]

        try:
            preds_raw = predict(text, args.url)
            preds = [(s, e, lbl) for s, e, lbl in preds_raw if lbl in EVAL_ENTITIES]
        except Exception as exc:
            errors.append({"idx": idx, "error": str(exc)})
            preds = []

        ex_tp, ex_fp, ex_fn = align(preds, gold)
        for d, v in [("tp", ex_tp), ("fp", ex_fp), ("fn", ex_fn)]:
            for lbl, cnt in v.items():
                if d == "tp": tp[lbl] += cnt
                elif d == "fp": fp[lbl] += cnt
                else: fn[lbl] += cnt

        if (idx + 1) % 10 == 0:
            print(f"  Processed {idx + 1}/{len(ds)}", end="\r")

    print(f"\nCompleted {len(ds)} examples. Errors: {len(errors)}")

    m = metrics(tp, fp, fn)

    # Print simple table
    print(f"\n{'Entity':<15} {'P':>7} {'R':>7} {'F1':>7} {'Sup':>7}")
    for lbl in sorted(k for k in m if k not in ("macro_avg", "micro_avg")):
        v = m[lbl]
        print(f"{lbl:<15} {v['precision']:>7.3f} {v['recall']:>7.3f} {v['f1']:>7.3f} {int(v['support']):>7}")
    print(f"{'MACRO':<15} {m['macro_avg']['precision']:>7.3f} {m['macro_avg']['recall']:>7.3f} {m['macro_avg']['f1']:>7.3f}")
    print(f"{'MICRO':<15} {m['micro_avg']['precision']:>7.3f} {m['micro_avg']['recall']:>7.3f} {m['micro_avg']['f1']:>7.3f}")

    report = {
        "dataset": args.dataset,
        "split": args.split,
        "url": args.url,
        "metrics": m,
        "errors": errors,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    ts = time.strftime("%Y%m%d_%H%M%S")
    out_path = out_dir / f"{args.dataset}_{args.split}_{ts}.json"
    out_path.write_text(json.dumps(report, indent=2))
    print(f"\nReport saved to {out_path}")


if __name__ == "__main__":
    main()