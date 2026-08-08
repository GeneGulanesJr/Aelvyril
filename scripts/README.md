# Aelvyril live E2E harness

This directory is the **single source of truth** for the live end-to-end test
harness that exercises Aelvyril's full privacy pipeline (detect → pseudonymize
→ forward → rehydrate) against a mock OpenAI-compatible upstream. The same
scripts run identically in dev and CI.

| Script | Purpose |
| --- | --- |
| `mock_upstream.py` | Mock OpenAI-compatible upstream. Logs full request bodies (the wire evidence) and echoes user content back so the gateway can rehydrate it. |
| `corpus_test.py` | Full **40-type** PII corpus with per-layer coverage output (LIQUID + GATEWAY). |
| `e2e_test.py` | Focused single-request smoke test: asserts originals restored + no token leaks. Run this first to confirm the harness is wired, then the corpus for coverage. |

## How to run the live E2E

You need four processes. Open four terminals (or run them backgrounded):

**1. Presidio sidecar (port 3031) — the analyzer + Liquid PII encoder.**

```sh
cd src-tauri
PRESIDIO_PORT=3031 AELVYRIL_LIQUID_PII_ENABLED=1 python3 presidio_service.py
```

**2. Mock upstream (port 9999) — stands in for the real LLM provider.**

```sh
python3 scripts/mock_upstream.py 9999
```

(Optionally pass a second arg for a custom log path; default
`/tmp/mock_upstream.log`. The mock truncates the log on startup.)

**3. Headless gateway (port 4242) — Aelvyril with no UI, benchmark mode.**

```sh
PRESIDIO_PORT=3031 AELVYRIL_KEY_BENCHMARKDUMMY=aelvyril-benchmark-key \
  cargo run --manifest-path src-tauri/Cargo.toml --bin aelvyril-headless
# …or, if already built:
PRESIDIO_PORT=3031 AELVYRIL_KEY_BENCHMARKDUMMY=aelvyril-benchmark-key \
  ./src-tauri/target/debug/aelvyril-headless
```

The headless binary injects a `BenchmarkDummy` provider that points at
`http://localhost:9999` and accepts model name `none`, so the corpus just sends
`"model": "none"`.

**4. Run the harness.**

```sh
python3 scripts/e2e_test.py     # smoke test first
python3 scripts/corpus_test.py  # then the full 40-type corpus
```

## Interpreting the two metrics

`corpus_test.py` prints two columns per row:

- **LIQUID** — *model-exact labels*. The analyzer pipeline pseudonymized the
  content at all (a token appeared on the wire). A `miss` here means the
  analyzer did not fire.
- **GATEWAY** — *right-token-type on the wire*. A token whose name matches the
  expected type (in either the legacy/Presidio namespace or the Liquid encoder
  UPPER_SNAKE namespace) appears in the forwarded request.

A **`miss(X)`** row where a token `X` *was* still emitted means the content
**was pseudonymized** — the gateway substituted a token, just of a different
type than the row expects (often a domain-overlap quirk, e.g. a date-of-birth
matched as `CONTACT_ADDRESS`). That is **not** a raw leak. For the real
privacy signal — did any original PII value reach the wire? — check the
raw-leak audit, which `e2e_test.py` prints under
`wire contained original PII (should be NONE)`.

### Token namespaces

Two namespaces of token names coexist and are both accepted by `corpus_test.py`:

| Type | Legacy / Presidio | Liquid encoder |
| --- | --- | --- |
| `contact.email` | `EMAIL_ADDRESS` | `CONTACT_EMAIL` |
| `contact.ip_address` | `IP_ADDRESS` | `CONTACT_IP_ADDRESS` |
| `credential.api_key` | `API_KEY` | `CREDENTIAL_API_KEY` |
| `financial.credit_card` | `CREDIT_CARD` | `FINANCIAL_CREDIT_CARD` |
| `financial.iban` | `IBAN_CODE` | `FINANCIAL_IBAN` |
| `identity.person_name` | `PERSON` | `IDENTITY_PERSON_NAME` |
| `identity.date_of_birth` | `DATE_TIME` | `IDENTITY_DATE_OF_BIRTH` (or `CONTACT_ADDRESS` — known overlap quirk) |

## Harness notes

- **Chunked bodies.** The gateway (reqwest) sends the first attempt of a
  forwarded request with `Transfer-Encoding: chunked`. The mock now parses
  chunked bodies (falling back to `Content-Length`), so each forward produces
  **exactly one** logged block — `wire blocks == requests`, not `2 × requests`.
- **Per-request block matching.** Each corpus request appends a unique marker
  `[[req-<n>]]` after the PII sample (detection is unaffected; the marker is
  not PII). The corpus selects the wire block whose content contains that
  marker, so read-ordering flakes are impossible.

## Syntax check

```sh
python3 -m py_compile scripts/*.py
```
