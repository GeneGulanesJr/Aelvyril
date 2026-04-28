# Aelvyril PII Detection Benchmarks

Reproducible benchmark suite for evaluating Aelvyril's PII detection accuracy against industry baselines.

**Primary Metric:** F₂ score (β=2, recall-weighted) — missing PII is worse than over-redaction.

## Quick Start

```bash
# Phase 1: Presidio-Research baseline (default)
python -m benchmarks.run

# Phase 2: Academic benchmarks (Nemotron-PII + TAB)
python -m benchmarks.run --suite phase2

# Phase 3: Supplementary benchmarks + dashboard
python -m benchmarks.run --suite phase3

# Run individual Phase 3 benchmarks
python -m benchmarks.run --suite datafog
python -m benchmarks.run --suite ai4privacy
python -m benchmarks.run --suite adversarial

# Generate comparison dashboard from existing results
python -m benchmarks.run --suite dashboard

# Run everything
python -m benchmarks.run --suite all
```

## Prerequisites

1. **Start the Aelvyril + Presidio stack:**
   ```bash
   docker compose -f benchmarks/docker-compose.bench.yml up -d
   ```

2. **Install benchmark dependencies:**
   ```bash
   pip install -r benchmarks/requirements.txt
   ```

3. **Verify service health:**
   ```bash
   curl http://localhost:3000/health
   ```

## Benchmark Phases

### Phase 1: Presidio-Research Integration (Weeks 1-2)

Quick wins — immediate baseline numbers comparing Aelvyril against vanilla Presidio.

- **Dataset:** 1,000+ synthetic LLM-prompt samples
- **Metrics:** F₂, F₁, Precision, Recall per entity type
- **Output:** `benchmarks/presidio_research/results/F2_AELVYRIL.md`

### Phase 2: Academic Credibility (Weeks 3-5)

Established academic benchmarks with published baselines.

| Benchmark | Source | Samples | Metrics |
|-----------|--------|---------|---------|
| **Nemotron-PII** | NVIDIA (CC BY 4.0) | 50,000 test | Strict-F1, Entity-F1, RougeL-F |
| **TAB** | NorskRegnesentral | 1,268 ECHR cases | R_direct, R_quasi, Weighted F1 |

**Nemotron-PII** (from NVIDIA) provides 50,000 production-quality test samples across 55 entity types and 50+ industry domains.

**TAB** goes beyond detection — it evaluates anonymization quality and re-identification risk.

#### Phase 2 Deliverables

- `BENCHMARK_RESULTS.md` — Nemotron-PII scores and per-entity breakdown
- `TAB_ANONYMIZATION_REPORT.md` — Re-identification risk assessment
- `ERROR_ANALYSIS.md` — FP/FN patterns and root causes
- `benchmarks/CROSS_BENCHMARK_MATRIX.md` — Cross-benchmark comparison

### Phase 3: Publication-Ready (Weeks 6-8)

Full transparency with supplementary benchmarks, adversarial testing, and auto-generated comparison tables.

| Benchmark | Source | Size | Purpose |
|-----------|--------|------|---------|
| **DataFog PII-NER** | HuggingFace | 500 samples | Head-to-head vs open-source model |
| **ai4privacy** | HuggingFace | 2,000 sample subset | Large-scale validation |
| **Adversarial** | Custom suite | 120+ test cases | Obfuscation/edge-case robustness |

**Adversarial categories tested:**
- Unicode homoglyph substitution
- Zero-width character injection
- Base64-encoded PII
- Leet-speak transformation
- Separator injection
- Edge cases: code context, JSON blobs, nested entities, partial redaction

#### Phase 3 Deliverables

- `BENCHMARK_COMPARISON.md` — Publication-ready comparison table with per-entity breakdown
- `benchmarks/results/latest.json` — Machine-readable aggregated results
- `DATAFOG_COMPARISON.md` — Head-to-head report
- `AI4PRIVACY_REPORT.md` — Large-scale validation report
- `ADVERSARIAL_REPORT.md` — Obfuscation/noise handling report
- `docs/BENCHMARK_METHODOLOGY.md` — Full methodology documentation

## Architecture

```
benchmarks/
├── run.py                          # CLI runner for all suites
├── config.yaml                     # All benchmark configuration
├── versions.lock                   # Pinned dependency/dataset versions
├── requirements.txt                # Python dependencies
├── docker-compose.bench.yml        # Aelvyril + Presidio stack
│
├── presidio_research/              # Phase 1
│   ├── aelvyril_evaluator.py       # HTTP endpoint wrapper
│   ├── evaluate.py                 # Phase 1 evaluation script
│   └── results/
│
├── pii_bench/                      # Phase 2a: Nemotron-PII (NVIDIA)
│   ├── downloader.py               # Dataset acquisition
│   ├── evaluator.py                # Full evaluation pipeline
│   ├── metrics.py                  # Strict-F1, Entity-F1, RougeL-F
│   └── results/
│
├── tab/                            # Phase 2b: TAB (Text Anonymization)
│   ├── downloader.py               # TAB corpus acquisition
│   ├── evaluator.py                # Anonymization quality evaluation
│   └── results/
│
├── supplementary/                  # Phase 3: Supplementary benchmarks
│   ├── datafog_evaluator.py        # DataFog PII-NER comparison
│   ├── ai4privacy_evaluator.py     # ai4privacy large-scale validation
│   ├── adversarial_evaluator.py    # Adversarial robustness testing
│   └── results/
│
├── dashboard/                      # Phase 3: Visualization
│   └── generate_charts.py          # Auto-generate comparison tables
│
├── data_generators/                # Synthetic data generation
│   └── llm_prompt_templates.py
│
├── common/                         # Shared utilities
│   ├── metrics.py                  # F₂, span matching
│   ├── reporting.py                # Markdown/JSON output
│   ├── statistics.py               # Bootstrap resampling (10k iterations)
│   ├── error_analysis.py           # FP/FN breakdown, confusion matrices
│   └── utils.py                    # Seeds, data loading
│
└── data/                           # Downloaded datasets (gitignored)
    ├── nemotron-pii/
    ├── tab/
    └── ai4privacy/
```

## Reproducibility

All benchmark runs are deterministic:

- **Fixed random seeds:** `seed=42` for all generators
- **`versions.lock`:** Pins dataset SHAs, dependency versions, model weights
- **Cache clearing:** Detection cache cleared before each run
- **Run manifest:** Each run writes `run_manifest.json` with full environment capture
- **Bootstrap resampling:** 10,000 iterations for 95% confidence intervals

## Dataset: Nemotron-PII (NVIDIA)

| Detail | Value |
|--------|-------|
| Source | https://huggingface.co/datasets/nvidia/Nemotron-PII |
| License | CC BY 4.0 |
| Test samples | 50,000 |
| Entity types | 55 |
| Domains | 50+ industries |
| Formats | Structured + unstructured |

*Previously used PII-Bench (THU-MIG) was removed from GitHub; replaced 2026-04-28.*

## Documentation

- **Methodology:** `docs/BENCHMARK_METHODOLOGY.md` — Full evaluation methodology
- **Plan:** `PiiBenchmarkPlan.md` — Implementation roadmap
- **Report:** `PiiBenchmarkReport.md` — Initial analysis and motivation
