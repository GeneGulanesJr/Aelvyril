# Plan: Liquid LFM2.5 Encoders for PII Detection + Policy Linting

**Goal:** Replace the generative LFM2.5-350M PII detector with the purpose-built
`LFM2.5-Encoder-350M-PII-Detector`, and add a new content-policy linting stage using
`LFM2.5-Encoder-350M-Policy-Linter`, in the **`src-tauri/` Rust gateway**.

---

## Context (read before implementing)

- **Two codebases live in this repo.** `src-tauri/` is the real Aelvyril privacy gateway
  (Rust/Tauri) where **all PII detection lives**. `src/` is an unrelated Node/TypeScript
  "7-agent pipeline" (`package.json`) with no PII engine. **All work is in `src-tauri/`.**
- **Current Liquid integration is *generative*.** `src-tauri/src/llama/detector.rs` runs
  LFM2.5-350M via **llama-server (GGUF)** as a feature-gated Layer 0 in
  `pii/engine.rs:251`. It prompts the model to emit a JSON array of PII entities, then maps
  labels to `PiiType` (`detector.rs:176`).
- **The new models are *encoders* (different runtime).** Both require `trust_remote_code=True`
  + `torch` + `transformers`; they are **not** GGUF and **cannot** be served by the existing
  `LlamaServer`. They run best via a **Python sidecar** — the same pattern as Presidio.
  - `LFM2.5-Encoder-350M-PII-Detector` → token-classification head, **40 PII types / 16
    languages**, uses a custom `pii_hybrid_decode.py` decode helper.
  - `LFM2.5-Encoder-350M-Policy-Linter` → zero-shot **rule-matching head**; scores text
    tokens against free-text rules in one pass (threshold `> 0.5`), uses custom
    `Lfm2BidirForRuleMatching` + a `rule_pool` construction (see model card).
  - Base `LFM2.5-Encoder-350M` is loaded implicitly by the two fine-tunes; not used directly.
- **The referenced `presidio_service.py` and `presidio_requirements.txt` are NOT in the repo**
  (only the Rust manager `pii/presidio_service.rs` + client `pii/presidio.rs` exist). They are
  listed as Tauri resources in `tauri.conf.json`. **This plan authors them.**
- Presidio client contract (from `pii/presidio.rs`): `POST /analyze`
  `{text, language, entities, score_threshold}` → `{result:[{entity_type, start, end, score}]}`;
  `GET /health`. New endpoints follow this shape.

## Resolved decisions

1. **PII role:** Replace the generative `LlamaDetector` with the **PII encoder** as the new
   Layer 0 NLP detector. Presidio + Rust regex remain as fallback layers (degrade gracefully).
2. **Policy-Linter:** New **outbound, post-pseudonymization** stage inspecting **user messages
   only**, before the upstream forward. **Per-rule action** `warn` (audit + forward) or
   `block` (reject request, return error to client, audit).
3. **Serving:** **Extend the Presidio sidecar** into one Python process (port 3000) adding
   `/liquid/pii` and `/liquid/policy`. Lazy-load each model on first request to its endpoint.
4. **Entity types:** Add **all 40** encoder types as new `PiiType` variants.
5. **Rules:** `policy_rules` in `settings.json` + a new **Settings UI "Policy" tab**.
6. **Acquisition:** Auto-download from Hugging Face (`trust_remote_code`) into
   `~/.aelvyril/models`, lazy-loaded; per-model Settings toggles.

## Scope

**In scope:** Python sidecar (Presidio + both Liquid models), Rust PII Layer-0 swap, Rust
policy stage + enforcement, `PiiType` expansion (40), config, audit (`policy_events` table),
frontend Policy tab + toggles, opt-in Cargo feature, tests/benchmarks.

**Out of scope:** changing the `src/` Node orchestrator; replacing upstream/cloud LLM calls
(encoders cannot generate); browser-extension/clipboard policy linting (gateway path only for
v1); model quantization/fine-tuning (use published weights as-is).

---

## Implementation tasks (ordered)

### Phase 1 — Python sidecar (author + extend)
1. Create `src-tauri/presidio_service.py` (currently missing) implementing:
   - `POST /analyze` (Presidio) and `GET /health` (existing contract).
   - `POST /liquid/pii` `{text}` → `{result:[{entity_type, start, end, score}]}` using the
     PII-Detector + `pii_hybrid_decode.py` (vendored from the model repo). Lazy-load on first
     call, guarded by env/arg enable flag.
   - `POST /liquid/policy` `{text, rules:[{text, action}]}` → `{violations:[{rule, action,
     token_text, start, end, score}]}` using `Lfm2BidirForRuleMatching` + the card's
     `rule_pool` construction; score threshold `0.5`. Lazy-load on first call.
   - Bind `127.0.0.1:3000`; honor `PRESIDIO_HOST`/`PRESIDIO_PORT` env (see
     `presidio_service.rs:129`).
2. Create `src-tauri/presidio_requirements.txt`: existing Presidio deps **plus**
   `torch`, `transformers`, `huggingface_hub`.
3. Add first-run model download helper (HF `snapshot_download` w/ `trust_remote_code`) to
   `~/.aelvyril/models/{pii-detector,policy-linter}`; log progress to stderr.
4. Confirm `tauri.conf.json` `resources` already lists both files (it does) — keep them as
   bundled resources.

### Phase 2 — Rust PII: replace Layer 0 with the encoder
5. Add a `LiquidPiiClient` (new `pii/liquid.rs`) mirroring `PresidioClient`
   (`pii/presidio.rs`): same retry/timeout/error shape, posts to `/liquid/pii`, maps the
   encoder's 40 `entity_type` strings to `PiiType`.
6. **Expand `PiiType`** (`pii/recognizers.rs`) with all 40 variants and update `Display`
   (UPPER_SNAKE_CASE to match the benchmark namespace noted in `presidio.rs:100`). The 40
   types (grouped): identity (`person_name`, `ssn`, `national_id`, `passport`,
   `drivers_license`, `date_of_birth`, `tax_id`); contact (`email`, `phone`, `address`,
   `postal_code`, `ip_address`); financial (`credit_card`, `iban`, `bank_account`,
   `swift_bic`, `crypto_wallet`, `amount`); credentials (`api_key`, `password`,
   `private_key`, `jwt`, `connection_string`, `login_credentials`); online (`username`,
   `url`); device (`mac_address`, `imei`, `device_id`); location (`gps_coordinates`);
   healthcare (`medical_record`, `condition`, `medication`, `health_plan_id`);
   organization (`company_name`); special-category (`religion`, `political`, `orientation`,
   `health_status`); legal (`case_number`). Map existing variants where names collide.
7. Update ripple sites for the new variants: `pseudonym/tokenizer.rs` (token naming),
   `pseudonym/rehydrator.rs`, `engine.rs::type_specificity` (`engine.rs:414`), and the
   label→`PiiType` mapping in `pii/liquid.rs`.
8. **Swap Layer 0** in `PiiEngine` (`pii/engine.rs`): add an optional
   `liquid_pii: Option<LiquidPiiClient>` field (mirror the `llama` field at `engine.rs:38`),
   wire it into `detect()` at `engine.rs:255` as the new Layer 0 (encoder), and **remove the
   generative `llama` detector from the PII path** (delete `init_llama`/`set_llama_detector`
   usage and the `#[cfg(feature="llama")]` Layer-0 block). Keep the `llama/` module files for
   non-PII reuse but detach them from the engine.
9. Update bootstrap: replace `spawn_llama_init`/`find_gguf_model`
   (`bootstrap/setup.rs:113`, `:137`) with a `spawn_liquid_init` that waits for the sidecar
   and flips the `LiquidPiiClient` enabled flag from config. Non-fatal on failure (degrade to
   Presidio + regex).

### Phase 3 — Rust policy-linter stage
10. Add `policy/linter.rs` (new module): a `LiquidPolicyClient` that posts to `/liquid/policy`
    with the active rules from config; returns violations.
11. Add the gateway hook: in the request path that calls `gateway/pii_handler.rs`
    (`detect` at `:29`, `pseudonymize_and_store` at `:43`) **before** `forward.rs`
    (`forward_and_rehydrate` at `:33`), extract **user-role message text only**, run the
    linter on the **post-pseudonymized** text. On any `block` violation: short-circuit with
    an error response to the client; always write audit entries for warn+block.
12. Add `audit/store.rs` schema: new `policy_events` table
    `(id, timestamp, session_id, rule_text, action, token_text, start, end, score, blocked)`
    + insert/query methods + CSV export column. Do **not** alter the existing
    `audit_entries` schema.

### Phase 4 — Config + feature gating
13. Extend `config/mod.rs`: `liquid_pii_enabled: bool`, `liquid_policy_enabled: bool`,
    `liquid_model_dir: Option<String>` (default `~/.aelvyril/models`), and
    `policy_rules: Vec<PolicyRule>` where `PolicyRule { text: String, action:
    Warn|Block, enabled: bool }`. Defaults: both models off, empty rules.
14. Add Cargo feature `liquid-encoder` in `src-tauri/Cargo.toml` `[features]`
    (off by default; mirrors `llama` at `Cargo.toml:58`). Gate the new Rust modules behind it.
    **Confirm with user during implementation** whether default-on is preferred.
15. Update `bin/aelvyril-headless.rs` (`Cargo.toml:72`, `required-features`) to also support
    `liquid-encoder`.

### Phase 5 — Frontend
16. Add `src/components/settings/PolicySection.tsx` (mirror `ListsSection.tsx` + `RuleRow.tsx`):
    CRUD for `policy_rules` (text, warn/block, enabled toggle).
17. Extend `DetectionSection.tsx` with toggles for "Liquid PII encoder" and "Liquid policy
    linter".
18. Update `src/hooks/tauri/types.ts` with the new config fields + `PolicyRule` type and wire
    the new Settings tab into `src/pages/Settings`.

### Phase 6 — Validation
19. **Rust unit tests:** 40-way encoder-label → `PiiType` mapping; `/liquid/pii` response
    parsing; `/liquid/policy` violation parsing; rule enable/action filtering; overlap
    resolution for new types.
20. **Integration tests** (`src-tauri/tests/`): start the Python sidecar on a test port,
    assert PII detection on known spans and a policy `block` short-circuits the forward path.
    Provide a mock sidecar fixture so tests run without GPU/large downloads in CI.
21. **Fallback tests:** with `liquid-encoder` off or sidecar down, the pipeline must still
    detect PII via Presidio + regex and forward normally (no policy enforcement).
22. **Benchmark:** compare Layer-0 latency/throughput (encoder vs prior generative path) via
    `benchmark.rs` (`benchmark.rs:181`); document CPU memory (~1.4 GB/model F32) and long-prompt
    behavior (chunk/window if the encoder's token budget is exceeded).
23. Run `cargo test` (Rust) and `npm run test:run` (vitest, frontend) before handing off.

---

## Key integration points

| Concern | Location |
|---|---|
| PII Layer 0 detect | `src-tauri/src/pii/engine.rs:251` (swap `llama` block → `liquid_pii`) |
| PII engine fields/init | `pii/engine.rs:38,112,122` |
| `PiiType` enum + `Display` | `src-tauri/src/pii/recognizers.rs` |
| Presidio client pattern to mirror | `src-tauri/src/pii/presidio.rs:103,237,408` |
| Sidecar process manager | `src-tauri/src/pii/presidio_service.rs:54,99` |
| Tokenizer/rehydrator ripple | `src-tauri/src/pseudonym/tokenizer.rs`, `rehydrator.rs` |
| Gateway detect→pseudonymize | `src-tauri/src/gateway/pii_handler.rs:29,43` |
| Gateway forward (policy hook) | `src-tauri/src/gateway/forward.rs:33` |
| Config fields | `src-tauri/src/config/mod.rs:33,35` |
| Audit schema | `src-tauri/src/audit/store.rs:40` |
| Bootstrap init | `src-tauri/src/bootstrap/setup.rs:113,137` |
| Cargo features | `src-tauri/Cargo.toml:56,72` |
| Frontend settings | `src/components/settings/{DetectionSection,ListsSection,RuleRow}.tsx`, `src/hooks/tauri/types.ts`, `src/pages/Settings` |

## Risks & mitigations

- **Footprint:** ~1.4 GB/model RAM (F32) + torch/transformers in the sidecar. Mitigation:
  lazy-load, per-model toggles, off by default; document the cost. (Quantization deferred.)
- **Latency:** PII encoder runs on every request. Mitigation: optional + behind toggle;
  window/chunk long prompts; reuse the existing `PiiCache` (`state.rs:39`) for repeats.
- **Supply chain:** `trust_remote_code=True` executes vendor Python. Mitigation: pin to the
  specific model revisions; vendor `pii_hybrid_decode.py` + `train_bizlint_v02.py` into the
  repo and document the pinned commit.
- **Degradation:** sidecar down must never break the gateway. Mitigation: every new path
  returns `None`/empty and falls through to Presidio + regex (preserve existing behavior).
- **Block disruption:** `block` rules can loop coding agents. Mitigation: default shipped
  rules empty; document; audit every event.

## Open details to confirm during implementation

- Default-on vs opt-in for the `liquid-encoder` Cargo feature (recommended opt-in).
- Whether the policy linter should also inspect clipboard/extension paths (deferred for v1).
- HF cache location vs `~/.aelvyril/models` (recommend the latter for portability).
- Whether to vendor the model's custom helper scripts (recommend yes, pinned).
