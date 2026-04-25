# Aelvyril PII Detection — presidio-research Recipe

This recipe evaluates **Aelvyril** — a privacy gateway that detects and pseudonymizes PII
before forwarding requests to upstream LLM providers — using the presidio-research
evaluation framework.

## How Aelvyril Works

Aelvyril is a local desktop proxy (Tauri v2, Rust backend) that:

1. **Detects PII** using native Rust regex recognizers (10 entity types) + optional Presidio NER passthrough (Person, Location, Organization)
2. **Pseudonymizes** detected entities with typed tokens (`[Email_1]`, `[SSN_2]`)
3. **Forwards** sanitized requests to upstream LLM providers (OpenAI, Anthropic, etc.)
4. **Rehydrates** upstream responses by replacing tokens with original values

Architecture: Client → Aelvyril Gateway → Upstream Provider → Aelvyril Rehydration → Client

## Quick Start

### Prerequisites

- Python 3.11+
- `pip install requests numpy presidio-evaluator`
- Aelvyril running with the mock PII service: `python benchmarks/mock_service.py`

### Run Evaluation

```bash
# Generate synthetic dataset and evaluate
python -m benchmarks.run --suite phase1 --num-samples 1000

# Generate comparison dashboard
python -m benchmarks.dashboard.generate_charts
```

### With Docker

```bash
docker compose -f benchmarks/docker-compose.bench.yml up -d
python -m benchmarks.run --suite all
```

## Custom Evaluator

The `AelvyrilEvaluator` class wraps Aelvyril's `/analyze` HTTP endpoint:

```python
from benchmarks.presidio_research.aelvyril_evaluator import AelvyrilEvaluator

evaluator = AelvyrilEvaluator(service_url="http://localhost:5000/analyze")

# Run against synthetic data
from benchmarks.presidio_research.evaluate import run_evaluation
results = run_evaluation(evaluator, num_samples=1000)
```

Key design decisions:
- **Live endpoint**: Benchmarks the full production path (regex + NER + overlap resolution + allow/deny lists), not isolated components
- **Exponential backoff**: 3 retries with [1, 2, 4]s delays on transient failures
- **Failure tracking**: Runs with >1% failure rate are invalidated
- **Schema validation**: Emitter validates response schema before first evaluation call

## Supported Entity Types

| Entity | Source | Method |
|--------|--------|--------|
| Email | Aelvyril native | Regex |
| Phone Number | Aelvyril native | Regex (context-aware) |
| SSN | Aelvyril native | Regex |
| Credit Card | Aelvyril native | Regex + Luhn |
| IBAN | Aelvyril native | Regex + checksum |
| IP Address | Aelvyril native | Regex + code-context filter |
| API Key | Aelvyril native | Regex |
| Domain | Aelvyril native | Regex |
| Date | Aelvyril native | Regex |
| Zip Code | Aelvyril native | Regex |
| Person Name | Presidio passthrough | spaCy NER |
| Location | Presidio passthrough | spaCy NER |
| Organization | Presidio passthrough | spaCy NER |

## Metrics

- **F₂ (β=2)**: Primary metric — recall-weighted, reflecting Aelvyril's threat model (missing PII > over-redaction)
- **Per-entity F₂**: Individual entity type scores
- **Bootstrap CI**: 10,000 iterations for 95% confidence intervals

## Benchmark Suites

| Suite | Description | Dataset |
|-------|-------------|---------|
| Phase 1 (Presidio-Research) | F₂ vs vanilla Presidio | Synthetic (stdlib-only generator) |
| Phase 2 (PII-Bench) | Strict-F1 vs GPT-4o/DeepSeek | Synthetic fallback (official dataset 404) |
| Phase 2 (TAB) | Anonymization quality (R_direct, R_quasi) | 127 ECHR court cases |
| Phase 3 (Adversarial) | Robustness against obfuscation | Synthetic adversarial samples |
| Phase 3 (DataFog) | Head-to-head vs open-source PII-NER | Synthetic |

## Reproducibility

```bash
# Deterministic run with fixed seed
python -m benchmarks.run --suite all --seed 42 --clear-cache

# Version-pin all dependencies
cat benchmarks/versions.lock | python -m json.tool
```

## Results

See [BENCHMARK_COMPARISON.md](../../BENCHMARK_COMPARISON.md) for the latest comparison table.

## Contributing

To add a new evaluation:

1. Create an evaluator in `benchmarks/<suite>/evaluator.py` implementing `predict(sample) -> List[DetectedSpan]`
2. Add a runner in `benchmarks/run.py` (`_run_<suite>`)
3. Register the suite in the CLI argument parser
4. Add result loading in `benchmarks/dashboard/generate_charts.py` → `collect_all_results()`

## References

- [Aelvyril GitHub](https://github.com/GeneGulanesJr/Aelvyril)
- [presidio-research](https://github.com/microsoft/presidio-research)
- [PII-Bench (arxiv:2502.18545)](https://arxiv.org/abs/2502.18545)
- [TAB Benchmark (arxiv:2202.00443)](https://arxiv.org/abs/2202.00443)
