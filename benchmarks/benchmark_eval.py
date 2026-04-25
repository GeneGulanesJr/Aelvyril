#!/usr/bin/env python3
"""Run NER evaluation on a labeled test set.

Usage:
    python benchmarks/benchmark_eval.py --input benchmarks/sample_test.json --url http://localhost:5000
"""
import argparse, json, sys, time
from collections import defaultdict
from pathlib import Path

import requests

# Presidio entity types we expect to evaluate against
EVAL_ENTITIES = {"PERSON", "LOCATION", "ORGANIZATION", "NRP", "EMAIL_ADDRESS", "PHONE_NUMBER", "API_KEY", "DATE_TIME"}

def load_examples(path: str):
    p = Path(path)
    if not p.exists():
        sys.exit(f"Input file not found: {path}")
    data = json.loads(p.read_text())
    # Accept either list directly or {"examples": [...]}
    if isinstance(data, dict) and "examples" in data:
        data = data["examples"]
    return data

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
        _, _, lbl = p
        if p in gold_set:
            tp[lbl] += 1
        else:
            fp[lbl] += 1
    for g in gold_set:
        if g not in pred_set:
            fn[g[2]] += 1
    return tp, fp, fn

def compute_metrics(tp, fp, fn):
    result = {}
    all_labels = sorted(set(tp) | set(fp) | set(fn))
    for lbl in all_labels:
        t, f, n = tp[lbl], fp[lbl], fn[lbl]
        p = t / (t + f) if (t + f) > 0 else 0.0
        r = t / (t + n) if (t + n) > 0 else 0.0
        f1 = 2 * p * r / (p + r) if (p + r) > 0 else 0.0
        result[lbl] = {"precision": p, "recall": r, "f1": f1, "support": t + n}

    tp_total = sum(tp.values()); fp_total = sum(fp.values()); fn_total = sum(fn.values())
    micro_p = tp_total / (tp_total + fp_total) if (tp_total + fp_total) > 0 else 0.0
    micro_r = tp_total / (tp_total + fn_total) if (tp_total + fn_total) > 0 else 0.0
    micro_f1 = 2 * micro_p * micro_r / (micro_p + micro_r) if (micro_p + micro_r) > 0 else 0.0

    result["macro_avg"] = {
        "precision": sum(v["precision"] for v in result.values() if isinstance(v, dict)) / len([v for v in result.values() if isinstance(v, dict)]),
        "recall": sum(v["recall"] for v in result.values() if isinstance(v, dict)) / len([v for v in result.values() if isinstance(v, dict)]),
        "f1": sum(v["f1"] for v in result.values() if isinstance(v, dict)) / len([v for v in result.values() if isinstance(v, dict)]),
    }
    result["micro_avg"] = {"precision": micro_p, "recall": micro_r, "f1": micro_f1}
    return result

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="benchmarks/sample_test.json", help="Test set JSON (list of {\"text\", \"gold\"})")
    ap.add_argument("--url", default="http://localhost:5000", help="Presidio service URL")
    ap.add_argument("--output", default="benchmarks/results", help="Output directory for JSON reports")
    args = ap.parse_args()

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    examples = load_examples(args.input)
    print(f"Loaded {len(examples)} examples from {args.input}")

    tp, fp, fn = defaultdict(int), defaultdict(int), defaultdict(int)
    errors = []

    for idx, ex in enumerate(examples):
        text = ex["text"]
        gold = [(g["start"], g["end"], g["label"]) for g in ex["gold"]]

        try:
            preds_raw = predict(text, args.url)
            preds = [(s, e, lbl) for s, e, lbl in preds_raw if lbl in EVAL_ENTITIES]
        except Exception as exc:
            errors.append({"idx": idx, "error": str(exc), "text": text})
            preds = []

        ex_tp, ex_fp, ex_fn = align(preds, gold)
        for d, v in [("tp", ex_tp), ("fp", ex_fp), ("fn", ex_fn)]:
            for lbl, cnt in v.items():
                if d == "tp": tp[lbl] += cnt
                elif d == "fp": fp[lbl] += cnt
                else: fn[lbl] += cnt

        if (idx + 1) % 1 == 0:
            print(f"  [{idx+1}/{len(examples)}] {text[:40]:40s}  TP={sum(ex_tp.values())} FP={sum(ex_fp.values())} FN={sum(ex_fn.values())}")

    print(f"\nCompleted {len(examples)} examples. Errors: {len(errors)}")

    m = compute_metrics(tp, fp, fn)

    # Print plain table
    print(f"\n{'Entity':<20} {'P':>7} {'R':>7} {'F1':>7} {'Sup':>7}")
    for lbl in sorted([l for l in m if l not in ("macro_avg", "micro_avg")]):
        v = m[lbl]
        print(f"{lbl:<20} {v['precision']:>7.3f} {v['recall']:>7.3f} {v['f1']:>7.3f} {int(v['support']):>7}")

    print(f"{'MACRO AVG':<20} {m['macro_avg']['precision']:>7.3f} {m['macro_avg']['recall']:>7.3f} {m['macro_avg']['f1']:>7.3f}")
    print(f"{'MICRO AVG':<20} {m['micro_avg']['precision']:>7.3f} {m['micro_avg']['recall']:>7.3f} {m['micro_avg']['f1']:>7.3f}")

    report = {
        "input_file": args.input,
        "url": args.url,
        "metrics": m,
        "errors": errors,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    ts = time.strftime("%Y%m%d_%H%M%S")
    out_path = out_dir / f"eval_{ts}.json"
    out_path.write_text(json.dumps(report, indent=2))
    print(f"\nFull report: {out_path}")

if __name__ == "__main__":
    main()