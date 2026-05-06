# Pattern Mining Integration Design for Aelvyril

## 1. Overview

The Pattern Mining system enables Aelvyril to automatically discover, validate, and deploy new PII detection patterns from examples observed in the audit log. This creates a closed-loop learning system where real PII instances train the detector, which is then validated, generalized into regex patterns, and hot-reloaded into the PiiEngine without restarting the application.

**Key Goals:**
- **Zero-touch pattern discovery**: Automatically cluster similar PII values from audit entries
- **Confidence-based validation**: Use LFM (Language Flow Model) to generate high-precision regex patterns
- **Safe deployment**: Human-in-the-loop validation before production use
- **Hot-reload**: Apply new patterns to running engine with zero downtime
- **Privacy-preserving**: Never store raw PII beyond pattern mining session

**Architecture Layers:**
```
Audit Log → PII Examples Store → Orchestrator Task → LFM → Validation → Deploy → PiiEngine
     ↓           ↓                     ↓              ↓           ↓          ↓
  SQLite    pii_examples        State Machine   Prompt    Sample    Hot-reload
                                          Table     Template  Testing  File Watcher
```

---

## 2. Audit Store Extension

### 2.1 New `pii_examples` Table Schema

Add the following table to the existing `audit_entries` schema in `src-tauri/src/audit/store.rs`:

```sql
CREATE TABLE IF NOT EXISTS pii_examples (
    id                TEXT PRIMARY KEY,
    task_id           TEXT NOT NULL,               -- Orchestrator task that generated this example
    session_id        TEXT NOT NULL,               -- Session where PII was detected
    entity_type       TEXT NOT NULL,               -- PiiType enum string (Email, Phone, etc.)
    raw_value         TEXT NOT NULL,               -- The actual PII text (sanitized for mining only)
    normalized_value TEXT,                        -- Normalized form for clustering (e.g., lowercased)
    timestamp         TEXT NOT NULL,               -- When this example was captured
    confidence        REAL NOT NULL,               -- Detection confidence from PiiEngine
    source            TEXT NOT NULL DEFAULT 'presidio',  -- presidio | llama | custom
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pii_examples_task ON pii_examples(task_id);
CREATE INDEX IF NOT EXISTS idx_pii_examples_type ON pii_examples(entity_type);
CREATE INDEX IF NOT EXISTS idx_pii_examples_session ON pii_examples(session_id);

-- Table to track pattern mining task metadata
CREATE TABLE IF NOT EXISTS pattern_mining_runs (
    id                TEXT PRIMARY KEY,
    task_id           TEXT NOT NULL,
    state             TEXT NOT NULL,               -- Current phase: INTAKE, COLLECT, CLUSTER, GENERALIZE, VALIDATE, DEPLOY
    started_at        TEXT NOT NULL,
    completed_at      TEXT,
    examples_count    INTEGER NOT NULL DEFAULT 0,
    clusters_count    INTEGER NOT NULL DEFAULT 0,
    patterns_count    INTEGER NOT NULL DEFAULT 0,
    deployed_count    INTEGER NOT NULL DEFAULT 0,
    error_log         TEXT NOT NULL DEFAULT '[]',
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mining_runs_task ON pattern_mining_runs(task_id);
```

**Rationale:**
- `raw_value` stored separately from audit_entries to isolate sensitive data; can be purged after pattern extraction
- `normalized_value` enables clustering without exposing raw data (e.g., lowercase, trim)
- `task_id` links mining run to orchestrator task for traceability
- `source` tracks which detector layer found the PII (presidio vs llama vs custom)
- `confidence` helps filter low-quality examples

### 2.2 Data Flow to `pii_examples`

In `PiiEngine::detect()` (engine.rs), after matches are resolved, add:

```rust
// Pseudocode - actual implementation in PiiEngine
pub async fn detect_and_log_examples(&self, text: &str, session_id: &str, task_id: Option<&str>) -> Vec<PiiMatch> {
    let matches = self.detect(text).await;
    
    // Log examples to audit store if task_id provided
    if let Some(task) = task_id {
        for m in &matches {
            audit_store::log_pii_example(task, session_id, &m.pii_type, &m.text, m.confidence, "presidio").await?;
        }
    }
    
    matches
}
```

The `audit/store.rs` gets a new module `examples.rs`:

```rust
// src-tauri/src/audit/examples.rs
use super::store::AuditStore;
use crate::pii::PiiType;

pub struct PiiExample {
    pub id: String,
    pub task_id: String,
    pub session_id: String,
    pub entity_type: PiiType,
    pub raw_value: String,
    pub normalized_value: String,
    pub timestamp: DateTime<Utc>,
    pub confidence: f64,
    pub source: String,
}

impl AuditStore {
    pub fn log_pii_example(
        &self,
        task_id: &str,
        session_id: &str,
        entity_type: &PiiType,
        raw_value: &str,
        confidence: f64,
        source: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        let id = Uuid::new_v4().to_string();
        let normalized = normalize_for_clustering(raw_value);
        
        conn.execute(
            "INSERT INTO pii_examples (id, task_id, session_id, entity_type, raw_value, normalized_value, timestamp, confidence, source)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id,
                task_id,
                session_id,
                entity_type.to_string(),
                raw_value,
                normalized,
                Utc::now().to_rfc3339(),
                confidence,
                source,
            ],
        ).map_err(|e| format!("Failed to log PII example: {}", e))?;
        Ok(())
    }
    
    pub fn get_examples_for_task(&self, task_id: &str, entity_type: Option<&str>) -> Result<Vec<PiiExample>, String> {
        // Query with optional entity_type filter
        // ...
    }
}
```

---

## 3. Custom Recognizers JSON Format

### 3.1 File Location and Naming

```
<data_local_dir>/aelvyril/custom_recognizers.json
e.g. ~/.local/share/aelvyril/custom_recognizers.json on Linux
```

### 3.2 JSON Schema

```json
{
  "$schema": "https://aelvyril.dev/schemas/custom_recognizers.json",
  "version": "1.0",
  "recognizers": [
    {
      "id": "custom_email_variant_1",
      "pii_type": "Email",
      "regex": "(?i)\\b[A-Za-z0-9._%+-]+@(company|corp|internal)\\.local\\b",
      "confidence": 0.85,
      "description": "Detects internal corporate email addresses",
      "validator": "is_not_test_email",
      "enabled": true,
      "created_at": "2026-04-27T10:30:00Z",
      "updated_at": "2026-04-27T10:30:00Z"
    },
    {
      "id": "employee_id_pattern",
      "pii_type": "Custom",
      "custom_type_name": "EmployeeId",
      "regex": "\\bEMP[-_][A-Z]{3}\\d{4}\\b",
      "confidence": 0.75,
      "description": "Company-specific employee ID format",
      "validator": null,
      "enabled": true,
      "created_at": "2026-04-27T11:00:00Z",
      "updated_at": "2026-04-27T11:00:00Z"
    }
  ],
  "validators": {
    "is_not_test_email": "fn(value) { !value.contains('test') && !value.contains('example') }",
    "luhn_check": "standard"
  }
}
```

**Field Descriptions:**
- `id`: Unique identifier (UUID or descriptive slug)
- `pii_type`: Must match existing `PiiType` enum value OR "Custom" for new types
- `custom_type_name`: Required if `pii_type` is "Custom"; defines new entity type name
- `regex`: Rust regex string (no delimiters, same syntax as `regex` crate)
- `confidence`: 0.0-1.0; used for overlap resolution
- `description`: Human-readable description for UI
- `validator`: Optional; either name of built-in validator ("luhn_check", "iban_check") or custom JS-like function body
- `enabled`: Can be toggled without removing entry
- `created_at` / `updated_at`: ISO 8601 timestamps

### 3.3 Validator Definition

Validators are simple functions that receive `&str` and return `bool`. They can be:

1. **Built-in** — pre-compiled functions in Rust:
   - `"luhn_check"` → credit card Luhn algorithm
   - `"iban_check"` → IBAN checksum validation
   - `"ssn_format"` → SSN format validation (not checksum)

2. **Custom JS expressions** — evaluated in a sandboxed WASM/JS engine (future):
   - `"value => value.len() >= 5 && value.startsWith('EMP')"`
   - Currently, custom validators require Rust-side implementation; field reserved for future

### 3.4 Schema Validation

On load, validate:

```rust
#[derive(Deserialize)]
struct CustomRecognizers {
    version: String,
    recognizers: Vec<ExternalRecognizer>,
}

#[derive(Deserialize)]
struct ExternalRecognizer {
    id: String,
    pii_type: String,
    custom_type_name: Option<String>,
    regex: String,
    confidence: f64,
    description: String,
    validator: Option<String>,
    enabled: bool,
    created_at: String,
    updated_at: String,
}
```

Validation rules:
- `confidence` ∈ [0.0, 1.0]
- `regex` must compile via `regex::Regex::new()`
- `pii_type` must be valid enum or "Custom"
- If `pii_type` == "Custom", `custom_type_name` must be present and non-empty
- `id` unique among loaded recognizers
- `created_at` and `updated_at` valid RFC3339/ISO 8601

---

## 4. PiiEngine Modification to Load External Recognizers

### 4.1 Current State

Currently (`engine.rs` line 13): `static RECOGNIZERS: Lazy<Vec<Recognizer>> = Lazy::new(recognizers::all_recognizers);`

Recognizers are compile-time static.

### 4.2 New Architecture

Add a second recognizer source that is runtime-loaded and hot-reloaded:

```rust
// engine.rs additions

use std::sync::RwLock;
use std::path::PathBuf;

pub struct PiiEngine {
    allow_patterns: Vec<regex::Regex>,
    deny_patterns: Vec<regex::Regex>,
    presidio: PresidioClient,
    #[cfg(feature = "llama")]
    llama: Option<Arc<tokio::sync::RwLock<LlamaDetector>>>,
    // NEW: External recognizers loaded from JSON
    external_recognizers: Arc<RwLock<Vec<Recognizer>>>,
    custom_recognizers_path: PathBuf,
}

impl PiiEngine {
    pub fn new() -> Self {
        let custom_path = get_custom_recognizers_path();
        Self {
            allow_patterns: Vec::new(),
            deny_patterns: Vec::new(),
            presidio: PresidioClient::new("http://localhost:3000".into(), true),
            #[cfg(feature = "llama")]
            llama: None,
            external_recognizers: Arc::new(RwLock::new(load_external_recognizers(&custom_path).unwrap_or_default())),
            custom_recognizers_path: custom_path,
        }
    }
    
    /// Get a copy of external recognizers (for detection)
    pub fn external_recognizers(&self) -> Vec<Recognizer> {
        self.external_recognizers.read().unwrap().clone()
    }
    
    /// Reload external recognizers from disk (called by file watcher)
    pub fn reload_external_recognizers(&self) -> Result<(), String> {
        let new = load_external_recognizers(&self.custom_recognizers_path)?;
        let mut guard = self.external_recognizers.write().unwrap();
        *guard = new;
        Ok(())
    }
}
```

Modify `detect_with_recognizers` (line 142-172) to merge both sources:

```rust
fn detect_with_recognizers(&self, text: &str) -> Vec<PiiMatch> {
    let mut matches = Vec::new();
    
    // 1. Built-in recognizers (high confidence, well-tested)
    for recognizer in RECOGNIZERS.iter() {
        // ... existing logic
    }
    
    // 2. External recognizers (community/user-contributed, lower trust tier)
    for recognizer in self.external_recognizers.read().unwrap().iter() {
        if recognizer.confidence < MIN_CONFIDENCE {
            continue;
        }
        for mat in recognizer.regex.find_iter(text) {
            let matched_text = mat.as_str();
            if self.is_allowed(matched_text) {
                continue;
            }
            if let Some(validator) = &recognizer.validator {
                if !validator(matched_text) {
                    continue;
                }
            }
            matches.push(PiiMatch {
                pii_type: recognizer.pii_type.clone(),
                text: matched_text.to_string(),
                start: mat.start(),
                end: mat.end(),
                confidence: recognizer.confidence,
            });
        }
    }
    
    matches
}
```

**Key Points:**
- Built-in recognizers run first (priority order maintained)
- External recognizers run after; may have lower default confidence
- Duplicate detection handled by `resolve_overlaps()` (confidence-based tiebreak)
- External recognizers can define new `PiiType` variants via `custom_type_name` → maps to `PiiType::Custom(String)`

### 4.3 Loading External Recognizers

`src-tauri/src/pii/external.rs` (new module):

```rust
use regex::Regex;
use serde_json;
use std::fs;
use std::path::Path;
use crate::pii::recognizers::{PiiType, Recognizer};

#[derive(Debug, Clone)]
pub struct ExternalRecognizerConfig {
    pub id: String,
    pub pii_type: PiiType,
    pub regex: Regex,
    pub confidence: f64,
    pub validator: Option<fn(&str) -> bool>,
    pub enabled: bool,
}

pub fn load_external_recognizers<P: AsRef<Path>>(path: P) -> Result<Vec<Recognizer>, String> {
    let json = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read custom_recognizers.json: {}", e))?;
    
    let config: CustomRecognizers = serde_json::from_str(&json)
        .map_err(|e| format!("Invalid JSON in custom_recognizers.json: {}", e))?;
    
    let mut recognizers = Vec::new();
    
    for rec_cfg in config.recognizers {
        if !rec_cfg.enabled {
            continue;
        }
        
        // Compile regex
        let regex = Regex::new(&rec_cfg.regex)
            .map_err(|e| format!("Invalid regex for recognizer {}: {}", rec_cfg.id, e))?;
        
        // Resolve PII type
        let pii_type = if rec_cfg.pii_type == "Custom" {
            PiiType::Custom(rec_cfg.custom_type_name.unwrap_or_else(|| "Unknown".into()))
        } else {
            // Parse into existing enum; need add_from_str method or similar
            PiiType::from_str(&rec_cfg.pii_type).ok_or_else(|| 
                format!("Unknown pii_type '{}' for recognizer {}", rec_cfg.pii_type, rec_cfg.id)
            )?
        };
        
        // Resolve validator
        let validator = if let Some(val_name) = rec_cfg.validator {
            match val_name.as_str() {
                "luhn_check" => Some(recognizers::luhn_check),
                "iban_check" => Some(recognizers::iban_check),
                // Future: custom JS validators via WASM
                _ => return Err(format!("Unknown validator '{}' for recognizer {}", val_name, rec_cfg.id)),
            }
        } else {
            None
        };
        
        recognizers.push(Recognizer {
            pii_type,
            regex,
            confidence: rec_cfg.confidence.clamp(0.0, 1.0),
            validator,
        });
    }
    
    Ok(recognizers)
}
```

**Helper for PiiType parsing:**
Add to `recognizers.rs`:
```rust
impl PiiType {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "Email" => Some(PiiType::Email),
            "PhoneNumber" => Some(PiiType::PhoneNumber),
            "IpAddress" => Some(PiiType::IpAddress),
            "CreditCard" => Some(PiiType::CreditCard),
            "Ssn" => Some(PiiType::Ssn),
            "Iban" => Some(PiiType::Iban),
            "ApiKey" => Some(PiiType::ApiKey),
            "Domain" => Some(PiiType::Domain),
            "Date" => Some(PiiType::Date),
            "ZipCode" => Some(PiiType::ZipCode),
            "Person" => Some(PiiType::Person),
            "Location" => Some(PiiType::Location),
            "Organization" => Some(PiiType::Organization),
            "Custom" => None, // Must provide custom_type_name separately
            _ => None,
        }
    }
    
    pub fn is_custom(&self) -> bool {
        matches!(self, PiiType::Custom(_))
    }
}
```

**Path resolution:**
`src-tauri/src/pii/mod.rs` exports `get_custom_recognizers_path()`:

```rust
use dirs::data_local_dir;

pub fn get_custom_recognizers_path() -> PathBuf {
    if let Some(base) = data_local_dir() {
        base.join("aelvyril").join("custom_recognizers.json")
    } else {
        PathBuf::from("custom_recognizers.json") // Fallback to CWD
    }
}
```

---

## 5. Orchestrator Task State Machine for Pattern Mining

Pattern mining is a specialized orchestrator task mode `PatternMining`. Add to `types.rs`:

```rust
// TaskMode variant
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskMode {
    Planned,
    Direct,
    PatternMining,   // NEW
}

// Specialized subtask type for pattern mining phases
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MiningPhase {
    Intake,
    Collect,
    Cluster,
    Generalize,
    Validate,
    Deploy,
}
```

### 5.1 Phase Definitions

**INTAKE → COLLECT → CLUSTER → GENERALIZE → VALIDATE → DEPLOY**

| Phase | Input | Action | Output | Failure Mode |
|-------|-------|--------|--------|--------------|
| **INTAKE** | User request: "Mine patterns for Employee IDs" | Parse intent, identify target entity type, set mining parameters | MiningTask config with `target_entity` and `sample_size` | Invalid request (no target type) |
| **COLLECT** | `task_id` | Query `pii_examples` where `entity_type = target` and `task_id = ?` (or all if none) | Raw PII value list + metadata (confidence, source) | No examples found → abort with "Insufficient data" |
| **CLUSTER** | Raw values | Apply clustering algorithm (edit distance, token similarity) to group similar patterns | ClusterSet: `[{centroid: "...", examples: [...], size: n}, ...]` | All clusters too small (< MIN_CLUSTER_SIZE=5) → "Insufficient diversity" |
| **GENERALIZE** | Each cluster | Call LFM with prompt to generate regex pattern | `[{pattern: "...", cluster_id, preview_examples}]` | Pattern fails syntax check → retry with backoff (max 3) |
| **VALIDATE** | Generated patterns | Test precision/recall against held-out sample from cluster | ValidationResult: { precision, recall, sample_size, status: Pass/Fail } | Precision < 0.95 or Recall < 0.80 → reject |
| **DEPLOY** | Validated patterns | Write to `custom_recognizers.json` and call `PiiEngine::reload_external_recognizers()` | Newly active patterns in live engine | File write error → rollback to previous JSON version |

### 5.2 Subtask Structure

In `orchestrator/types.rs`, add:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatternMiningSubtask {
    pub mining_phase: MiningPhase,
    pub target_entity_type: String,     // e.g., "Email", "Custom:EmployeeId"
    pub examples_query: String,         // SQL WHERE clause or "ALL"
    pub cluster_params: ClusterConfig,  // Similarity thresholds
    pub generated_patterns: Vec<GeneratedPattern>,
    pub validation_results: Vec<ValidationResult>,
    pub deployed_pattern_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterConfig {
    pub max_edit_distance: u8,      // Default 2
    pub min_cluster_size: usize,    // Default 5
    pub tokenization: TokenizationStrategy, // "byte" | "word" | "ngram"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratedPattern {
    pub id: String,
    pub regex: String,
    pub confidence: f64,
    pub source_cluster: String,
    pub example_matches: Vec<String>,
    pub validation_status: ValidationStatus,
}
```

### 5.3 State Machine Implementation

In `orchestrator/executor.rs` or a new `pattern_miner.rs`, implement:

```rust
pub async fn run_pattern_mining_task(
    task_id: &str,
    repo_path: &Path,
    app_state: SharedState,
    orch_state: SharedOrchState,
    store: OrchestratorStore,
    cancel_rx: tokio::sync::watch::Receiver<bool>,
) -> Result<(), OrchestratorError> {
    let mut state = PatternMiningState::new(task_id, store.clone()).await?;
    
    loop {
        if *cancel_rx.borrow() {
            return Err(OrchestratorError::Cancelled);
        }
        
        match state.current_phase {
            MiningPhase::Intake => {
                // Parse configuration from task metadata
                state.parse_intake().await?;
                state.advance_to(MiningPhase::Collect).await?;
            }
            MiningPhase::Collect => {
                let examples = state.collect_examples().await?;
                if examples.len() < MIN_EXAMPLES {
                    return Err(OrchestratorError::InsufficientData);
                }
                state.save_examples(examples).await?;
                state.advance_to(MiningPhase::Cluster).await?;
            }
            MiningPhase::Cluster => {
                let clusters = state.cluster_examples().await?;
                if clusters.is_empty() {
                    return Err(OrchestratorError::NoClustersFound);
                }
                state.save_clusters(clusters).await?;
                state.advance_to(MiningPhase::Generalize).await?;
            }
            MiningPhase::Generalize => {
                let patterns = state.generate_patterns().await?;
                state.save_patterns(patterns).await?;
                state.advance_to(MiningPhase::Validate).await?;
            }
            MiningPhase::Validate => {
                let results = state.validate_patterns().await?;
                let valid = results.iter()
                    .all(|r| r.status == ValidationStatus::Pass);
                state.save_validation(results).await?;
                if valid {
                    state.advance_to(MiningPhase::Deploy).await?;
                } else {
                    return Err(OrchestratorError::ValidationFailed);
                }
            }
            MiningPhase::Deploy => {
                state.deploy_patterns().await?;
                state.mark_completed().await?;
                break;
            }
        }
    }
    Ok(())
}
```

**OrchestratorStore** adds tables:

```sql
-- Already in section 2: pattern_mining_runs
-- Also add:
CREATE TABLE IF NOT EXISTS mining_clusters (
    id               TEXT PRIMARY KEY,
    run_id           TEXT NOT NULL,
    centroid         TEXT NOT NULL,   -- Representative normalized value
    example_count    INTEGER NOT NULL,
    examples_json    TEXT NOT NULL,   -- JSON array of raw values
    FOREIGN KEY(run_id) REFERENCES pattern_mining_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS generated_patterns (
    id               TEXT PRIMARY KEY,
    run_id           TEXT NOT NULL,
    cluster_id       TEXT NOT NULL,
    regex            TEXT NOT NULL,
    confidence       REAL NOT NULL,
    example_matches  TEXT NOT NULL,   -- JSON array
    FOREIGN KEY(run_id) REFERENCES pattern_mining_runs(id) ON DELETE CASCADE,
    FOREIGN KEY(cluster_id) REFERENCES mining_clusters(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pattern_validation (
    id               TEXT PRIMARY KEY,
    pattern_id       TEXT NOT NULL,
    run_id           TEXT NOT NULL,
    precision        REAL NOT NULL,
    recall           REAL NOT NULL,
    sample_size      INTEGER NOT NULL,
    status           TEXT NOT NULL,   -- pass | fail
    notes            TEXT,
    FOREIGN KEY(pattern_id) REFERENCES generated_patterns(id) ON DELETE CASCADE,
    FOREIGN KEY(run_id) REFERENCES pattern_mining_runs(id) ON DELETE CASCADE
);
```

---

## 6. LFM Prompt Template for Regex Generation

Pattern generation calls the LFM (Language Flow Model) via the standard gateway. The prompt template is defined in `src-tauri/src/pii/pattern_miner.rs`:

### 6.1 Prompt Structure

```rust
const REGEX_GENERATION_PROMPT: &str = r#"
You are Aelvyril's Pattern Mining Assistant. Your job is to analyze a cluster of similar PII values and produce a single Rust regex pattern that matches ALL given examples while minimizing false positives.

TARGET ENTITY TYPE: {entity_type}

CLUSTER CENTROID (most common form): {centroid}

EXAMPLE VALUES (all from real data):
{examples_list}

REQUIREMENTS:
1. The regex MUST match every example above exactly.
2. The regex SHOULD be as specific as possible to avoid false matches (e.g., include TLD length for emails, Luhn structure for cards).
3. Use word boundaries (\b) where appropriate to prevent substring matches.
4. If the pattern includes variable parts (numbers, letters), use {digit} or {alpha} character classes or sensible quantifiers.
5. Output ONLY the regex pattern, no explanations. Return it as a raw string literal (no delimiters).

RUST REGEX SYNTAX REMINDER:
- \d for digits, [A-Z] for uppercase, [a-z] for lowercase
- + (1 or more), * (0 or more), ? (0 or 1), {n,m} (range)
- \b word boundary, \s whitespace, ^ start, $ end
- Do NOT use regex flags inline (the flag is set to case-insensitive on the engine side)

GOOD EXAMPLE: For cluster ["alice@company.local", "bob@company.local"] → "[A-Za-z0-9._%+-]+@company\.local"
BAD EXAMPLE: ".*@.*" (too broad)

Generate the pattern now:
"#;
```

### 6.2 Call via Gateway

```rust
use crate::gateway::{GatewayClient, CompletionRequest};

pub async fn generate_regex_with_lfm(
    entity_type: &str,
    centroid: &str,
    examples: &[String],
) -> Result<String, PatternMiningError> {
    let gateway = GatewayClient::new()?;
    
    let examples_list = examples.iter()
        .map(|e| format!("  - {}", e))
        .collect::<Vec<_>>()
        .join("\n");
    
    let prompt = REGEX_GENERATION_PROMPT
        .replace("{entity_type}", entity_type)
        .replace("{centroid}", centroid)
        .replace("{examples_list}", &examples_list);
    
    let request = CompletionRequest {
        model: "lfm2.5-350m",  // or config.planning_model
        messages: vec![
            ChatMessage::system("You are a regex generator for PII detection."),
            ChatMessage::user(&prompt),
        ],
        temperature: 0.1,   // Low temperature for deterministic output
        max_tokens: 100,    // Regex patterns are short
        stop: None,
    };
    
    let response = gateway.chat_completion(request).await?;
    let pattern = response.choices.first()
        .ok_or(PatternMiningError::EmptyResponse)?
        .message.content.trim()
        .to_string();
    
    // Post-process: remove markdown code fences if present
    let pattern = pattern
        .trim_start_matches("```regex")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim()
        .to_string();
    
    // Validate regex syntax
    regex::Regex::new(&pattern)
        .map_err(|e| PatternMiningError::InvalidRegex(e.to_string()))?;
    
    Ok(pattern)
}
```

### 6.3 Output Format

Expected LFM output:
```
\b[A-Za-z0-9._%+-]+@(company|corp|internal)\.local\b
```

**Validation:** The generated pattern is tested against all examples in the cluster. If any fail, LFM is re-prompted with feedback (max 3 retries).

---

## 7. Validation Strategy

Pattern mining introduces risk of false positives. Validation is a two-phase process:

### 7.1 Synthetic Validation (Immediate)

1. **Coverage Test** — Pattern must match 100% of cluster examples (exact or substring match). This ensures the generalization step didn't drop any observed forms.
2. **Specificity Benchmark** — Run pattern against a corpus of known non-PII text (code snippets, logs, documentation). If > 1% false positive rate on 10k lines of corpus, reject.
3. **Regex Complexity Check** — Reject patterns with catastrophic backtracking risk (nested quantifiers, exponential blowup potential). Simple heuristic: no `(a+)+` constructs.

```rust
pub async fn validate_pattern(
    pattern: &str,
    cluster_examples: &[String],
    negative_corpus: &[String],
) -> Result<ValidationResult, ValidationError> {
    let regex = Regex::new(pattern)?;
    
    // 1. Coverage
    let mut matched = 0;
    for ex in cluster_examples {
        if regex.is_match(ex) {
            matched += 1;
        }
    }
    let recall = matched as f64 / cluster_examples.len() as f64;
    if recall < 1.0 {
        return Err(ValidationError::IncompleteCoverage);
    }
    
    // 2. Precision on negative corpus (sample)
    let sample_size = negative_corpus.len().min(1000);
    let false_positives = negative_corpus.iter()
        .take(sample_size)
        .filter(|text| regex.is_match(text))
        .count();
    let precision = 1.0 - (false_positives as f64 / sample_size as f64);
    
    // 3. Complexity heuristic (basic)
    if pattern.contains("(.*){2,}") || pattern.matches("((").count() > 3 {
        return Err(ValidationError::TooComplex);
    }
    
    Ok(ValidationResult {
        precision,
        recall,
        sample_size,
        status: if precision > 0.95 && recall > 0.80 { ValidationStatus::Pass } else { ValidationStatus::Fail },
    })
}
```

### 7.2 Human-in-the-Loop Validation (Production)

Once a pattern passes synthetic validation, it enters the **VALIDATE** phase where the orchestrator:

1. Stores pattern in `generated_patterns` table with `status = pending_human_review`
2. Updates UI via Tauri event: `pattern-mining-validation-required` with payload `{run_id, pattern_id, regex, examples, metrics}`
3. Waits for user approval (or rejection with feedback)
4. On approval: marks pattern `status = approved` and proceeds to DEPLOY
5. On rejection: optionally stores feedback for LFM fine-tuning (future)

### 7.3 A/B Testing Option (Future)

New patterns could be deployed in "shadow mode" first:
- Pattern loaded into PiiEngine but flagged as `experimental`
- Matches are logged but not surfaced to user
- Compare against existing detector on ground truth dataset
- If performance ≥ existing, promote to production

---

## 8. Hot-Reload Mechanism

The system must support zero-downtime pattern updates. Two mechanisms:

### 8.1 File Watcher (Development / Native)

Use `notify` crate (already in Cargo.toml for Tauri) to watch `custom_recognizers.json`:

```rust
// src-tauri/src/pii/hot_reload.rs
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::sync::mpsc::channel;
use std::time::Duration;

pub fn start_watcher(
    path: PathBuf,
    engine_handle: Arc<PiiEngine>,
) -> Result<(), PatternMiningError> {
    let (tx, rx) = channel();
    
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(move |res| {
        match res {
            Ok(event) => {
                if event.paths.contains(&path) {
                    let _ = tx.send(()); // Debounce handled by receiver
                }
            }
            Err(e) => tracing::error!("Watch error: {}", e),
        }
    }).map_err(|e| PatternMiningError::WatcherCreate(e.to_string()))?;
    
    watcher.watch(&path, RecursiveMode::NonRecursive)
        .map_err(|e| PatternMiningError::WatcherWatch(e.to_string()))?;
    
    // Debounce thread
    std::thread::spawn(move || {
        let mut debounce_timer = None;
        loop {
            // Wait for event or timeout
            let timeout = Duration::from_millis(500);
            match rx.recv_timeout(timeout) {
                Ok(()) => {
                    // Event received; reset debounce timer
                    debounce_timer = Some(std::time::Instant::now() + Duration::from_secs(1));
                }
                Err(_) => {
                    // Timeout; check if debounce timer elapsed
                    if let Some(t) = debounce_timer {
                        if std::time::Instant::now() >= t {
                            // Reload
                            match engine_handle.reload_external_recognizers() {
                                Ok(_) => tracing::info!("Hot-reloaded custom recognizers"),
                                Err(e) => tracing::error!("Failed to reload: {}", e),
                            }
                            debounce_timer = None;
                        }
                    }
                }
            }
        }
    });
    
    Ok(())
}
```

Call from `main.rs` or Tauri `setup`:

```rust
// src-tauri/src/main.rs
use crate::pii::{PiiEngine, hot_reload};

fn setup_pii_engine() -> PiiEngine {
    let engine = PiiEngine::new();
    let custom_path = PiiEngine::get_custom_recognizers_path();
    
    // Start file watcher if in dev mode or user opted in
    #[cfg(debug_assertions)]
    {
        if let Err(e) = hot_reload::start_watcher(custom_path, Arc::new(engine)) {
            tracing::warn!("File watcher not started: {}", e);
        }
    }
    
    engine
}
```

### 8.2 Tauri Event-Based Reload (Production)

Since file watchers may not work in all deployment scenarios (e.g., Flatpak, Snap), expose a Tauri command:

```rust
// src-tauri/src/commands/pattern_mining.rs
#[tauri::command]
pub async fn reload_custom_recognizers(
    state: State<'_, SharedState>,
) -> Result<(), String> {
    let app_state = state.inner();
    let mut guard = app_state.pii_engine.write().await;
    guard.reload_external_recognizers()?;
    Ok(())
}
```

Frontend calls via `invoke('reload_custom_recognizers')` after saving JSON via settings UI.

Additionally, emit events when patterns change:

```rust
// After successful deploy:
emit_event("pattern-deployed", json!({
    "pattern_id": pattern.id,
    "regex": pattern.regex,
    "entity_type": pattern.entity_type,
}));
```

Frontend listens for `pattern-deployed` and updates pattern list UI in real time.

### 8.3 Debouncing & Error Handling

- **Debounce**: Wait 1 second after file modification before reloading (prevents partial-write reads)
- **Atomic writes**: Writes to JSON should use temp file + rename to ensure atomic replacement
- **Rollback on error**: If new JSON is invalid, keep old recognizers active and log error; optionally restore backup copy
- **Version tracking**: Store hash of current JSON; on reload, compute new hash and compare; if mismatch (concurrent edit), retry once

---

## 9. Integration Points

### 9.1 Tauri Commands

New commands in `src-tauri/src/commands/pattern_mining.rs`:

```rust
#[tauri::command]
pub async fn start_pattern_mining(
    target_entity: String,
    sample_size: Option<usize>,
    state: State<'_, SharedState>,
) -> Result<String, String> {
    // Create orchestrator task with mode = PatternMining
    // Returns task_id
}

#[tauri::command]
pub async fn get_mining_run_status(
    task_id: String,
    store: State<'_, OrchestratorStore>,
) -> Result<Option<MiningRunStatus>, String> {
    // Query pattern_mining_runs + derived metrics
}

#[tauri::command]
pub async fn approve_pattern(
    pattern_id: String,
    approved: bool,
    feedback: Option<String>,
    store: State<'_, OrchestratorStore>,
) -> Result<(), String> {
    // Update generated_patterns.status
    // If approved, trigger deploy phase
}
```

### 9.2 Frontend UI

New page: `src/pages/PatternMining.tsx`

**Workflow:**
```
┌─────────────────────────────────────────────────────────────┐
│ 1. Select Entity Type  →  "Custom:EmployeeId"             │
│ 2. Choose Data Source  →  "All sessions" | "Current"     │
│ 3. Set Parameters       →  Min examples: 50, Max: 10,000 │
│ 4. Start Mining         →  Creates orchestrator task      │
└─────────────────────────────────────────────────────────────┘
     ↓
┌─────────────────────────────────────────────────────────────┐
│ Mining Dashboard (live updates)                            │
│ • Phase: CLUSTER → GENERALIZE → VALIDATE                   │
│ • Cluster progress bar: 12 clusters discovered             │
│ • Generated pattern preview (regex highlighted)            │
│ • Validation metrics: Precision 0.97, Recall 0.89         │
│ • [Approve] [Reject] [Retry]                              │
└─────────────────────────────────────────────────────────────┘
     ↓ (Approve)
┌─────────────────────────────────────────────────────────────┐
│ Deployed! Pattern active in detector.                      │
│ [View in Recognizers List]                                 │
└─────────────────────────────────────────────────────────────┘
```

Events received:
- `pattern-mining-phase-update` → progress bar
- `pattern-generated` → new pattern card
- `pattern-validation-complete` → show metrics
- `pattern-deployed` → success notification

### 9.3 Settings Page Extension

`src/components/settings/DetectionSection.tsx` already handles custom denylist/allowlist patterns. Extend to show **Custom Recognizers** tab:

- List of active custom recognizers (from `custom_recognizers.json`)
- Edit form for each: regex, confidence, validator
- Import/export JSON
- "Test Pattern" button — runs regex against sample text

---

## 10. Security and Privacy

### 10.1 PII Example Handling

- Raw PII values are stored in `pii_examples.raw_value` **in plaintext** but **only in the local SQLite database** (already encrypted if full-disk encryption enabled)
- Access control: Only the local user can read the SQLite file (Unix file permissions)
- **Retention policy**: Raw values are automatically purged after pattern mining completes (success or failure). Keep only `normalized_value` for audit trail.
  ```sql
  DELETE FROM pii_examples WHERE raw_value IS NOT NULL AND task_id = ?;
  ```
- In memory: Raw examples are held in `PatternMiningState` but zeroized after cluster/generalize step using `zeroize` crate.

### 10.2 Pattern Generation Sandbox

LFM runs via gateway (separate process, memory-isolated). The generated regex is:
1. Syntax-checked via `regex::Regex::new()` (fails safely on malformed)
2. Tested against examples before approval
3. Not executed in privileged context; PII detection runs in main app but with same sandbox as existing Presidio

### 10.3 Audit Trail

All mining runs logged in `pattern_mining_runs`:
- Who started (user session if available)
- What entity type targeted
- How many examples used
- Which patterns deployed (with IDs)
- Timestamps for each phase

Enables compliance review (GDPR Article 22 automated decision-making log).

---

## 11. Error Handling and Recovery

| Error | Handling Strategy |
|-------|-------------------|
| `pii_examples` table missing | Auto-create via migration (AuditStore::migrate) |
| Invalid JSON in `custom_recognizers.json` | Log error, keep old recognizers active; emit UI event `"recognizers-load-failed"` |
| LFM call timeout/failure | Retry with exponential backoff (max 3), then abort phase with "Pattern generation service unavailable" |
| Cluster too small (< 5 examples) | Skip clustering, try collecting more examples or abort with informative message |
| Regex compilation fails after LFM | Re-prompt LFM with error message (max 3 retries), then abort |
| Pattern validation fails | Store failure reason; user can manually adjust regex and re-validate |
| Deploy fails (JSON write error) | Transactional write: write to temp file then rename; if fail, do not change active recognizers |
| File watcher error | Log and continue; user can manually reload |

**Recovery:**
- Failed mining runs can be retried with same or adjusted parameters
- Orphaned `pii_examples` without parent task are purged by daily cleanup job

---

## 12. Testing Strategy

**Unit Tests:**
- `tests/pii/external_recognizer_load.rs`: Valid/invalid JSON, regex compilation, type mapping
- `tests/pii/pattern_miner_cluster.rs`: Clustering algorithm on synthetic data
- `tests/orchestrator/pattern_mining_state_machine.rs`: Phase transitions with mock store
- `tests/audit/examples_store.rs`: Insert/query examples

**Integration Tests:**
- End-to-end: Given a corpus with known patterns, ensure pattern mining rediscovers them
- Hot-reload test: Modify `custom_recognizers.json` while engine running; verify new pattern detected

**Performance:**
- Cluster 10,000 examples in < 2 seconds (single-threaded)
- LFM prompt round-trip < 5 seconds (local model)
- Reload time < 100ms

---

## 13. Future Enhancements

1. **Active Learning**: Use rejected patterns to improve LFM prompts (feedback loop)
2. **Multi-language Patterns**: Support Unicode property classes (`\p{L}`) for international PII
3. **Confidence Calibration**: Learn confidence offsets per pattern from validation results
4. **Shared Community Repository**: Opt-in upload of anonymized patterns to community `custom_recognizers.json` repo (signed, verified)
5. **Pattern Versioning**: Keep history of pattern changes; ability to rollback
6. **Negative Example Mining**: Collect false positives to refine patterns
7. **GUI Regex Editor**: Visual pattern builder with live test against examples

---

## 14. Migration Path

**Version**: 1.0 → 1.1 (Pattern Mining)

1. **Schema migration** (on startup):
   ```sql
   -- Auto-run by AuditStore::migrate if version < 1.1
   CREATE TABLE IF NOT EXISTS pii_examples (...);
   CREATE TABLE IF NOT EXISTS pattern_mining_runs (...);
   -- etc.
   ```

2. **Backward compatibility**:
   - `PiiEngine::new()` unchanged signature; external_recognizers loaded from JSON if file exists
   - If JSON missing, engine works normally (no custom patterns)
   - Orchestrator ignores `PatternMining` tasks on old versions (status = "unsupported")

3. **Feature flag**:
   - `--enable-pattern-mining` CLI flag or setting `orchestrator.pattern_mining_enabled = true`
   - Disabled by default in 1.1, opt-in via settings

4. **Rollback**: Delete `custom_recognizers.json` and restart engine to revert to baseline.

---

## Appendix A: Table Reference

### A.1 SQLite Schema Summary

```sql
-- audit/
audit_entries           (existing)
pii_examples            (NEW)
  ├─ id, task_id, session_id, entity_type, raw_value, normalized_value, timestamp, confidence, source

-- orchestrator/
tasks                   (existing)
plans                   (existing)
subtasks                (existing)
execution_results       (existing)
validation_results      (existing)
orch_state              (existing)
pattern_mining_runs     (NEW)
  ├─ id, task_id, state, started_at, completed_at, examples_count, clusters_count, patterns_count, deployed_count, error_log
mining_clusters         (NEW)
  ├─ id, run_id, centroid, example_count, examples_json
generated_patterns      (NEW)
  ├─ id, run_id, cluster_id, regex, confidence, example_matches
pattern_validation      (NEW)
  ├─ id, pattern_id, run_id, precision, recall, sample_size, status, notes
```

### A.2 Rust Module Map

```
src-tauri/src/
├── audit/
│   ├── mod.rs          (exports AuditEntry, AuditStore, AuditStats)
│   ├── store.rs        (existing + examples CRUD)
│   ├── open.rs         (existing)
│   └── examples.rs     (NEW: PiiExample CRUD)
├── pii/
│   ├── mod.rs          (PiiEngine, PiiType export)
│   ├── engine.rs       (modified: external_recognizers field + merge logic)
│   ├── recognizers.rs  (modified: PiiType::from_str, luhn_check/iban_check exported)
│   ├── external.rs     (NEW: JSON loading, validation)
│   └── hot_reload.rs   (NEW: file watcher)
├── orchestrator/
│   ├── types.rs        (add TaskMode::PatternMining, MiningPhase, PatternMiningSubtask)
│   ├── state_store.rs  (add pattern_mining_* tables in schema)
│   ├── executor.rs     (extend with run_pattern_mining_task)
│   └── pattern_miner.rs (NEW: core mining logic, clustering, LFM call)
└── commands/
    ├── pattern_mining.rs (NEW: Tauri commands)
    └── mod.rs           (export)
```

---

**Document Version:** 1.0  
**Last Updated:** 2026-04-27  
**Author:** Hermes Agent (Nous Research)  
**Status:** Design Specification — Ready for implementation review
