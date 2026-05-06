# LLM PII Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- ]`) syntax for tracking.

**Goal:** Integrate the fine-tuned LFM2.5-350M GGUF model into Aelvyril's PiiEngine as a new detection layer via llama-server subprocess.

**Architecture:** Run `llama-server` as a managed child process (like the existing Presidio microservice pattern). The `LlamaDetector` calls it via HTTP, prompts the model with the trained chat template, parses JSON PII entities, and maps them to `PiiMatch`. It plugs into `PiiEngine` as Layer 0 (before Presidio and regex), controlled by the existing `llama` feature flag.

**Tech Stack:** `llama-server` (from llama.cpp), reqwest HTTP client, serde_json, tokio process management, existing PiiEngine layer system

**GGUF Model:** `~/Documents/GulanesKorp/huggingface/hub/gguf-pii-lfm350m/model-q4_k_m.gguf` (218.7 MB)

---

### Task 1: Create `src/llama/mod.rs` — LlamaServer process manager

**Files:**
- Create: `src-tauri/src/llama/mod.rs`
- Create: `src-tauri/src/llama/server.rs`

- [ ] **Step 1: Create `src/llama/mod.rs` with module exports**

```rust
pub mod server;

pub use server::LlamaServer;
```

- [ ] **Step 2: Create `src/llama/server.rs` — LlamaServer struct**

This manages `llama-server` as a child process. It starts the server on a random port, waits for it to be ready via `/health` endpoint, and provides an HTTP client to call it.

```rust
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::AsyncBufReadExt;
use tokio::process::{Child, Command};
use tokio::sync::RwLock;
use tracing;

static PORT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"HTTP server is listening on port (\d+)").unwrap());
const MAX_HEALTH_ATTEMPTS: usize = 30;
const HEALTH_POLL_INTERVAL_MS: u64 = 500;

/// Errors from the Llama server manager.
#[derive(Debug, Clone)]
pub enum LlamaError {
    NotRunning(String),
    StartFailed(String),
    RequestFailed(String),
    ParseError(String),
}

impl std::fmt::Display for LlamaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotRunning(msg) => write!(f, "Llama server not running: {}", msg),
            Self::StartFailed(msg) => write!(f, "Failed to start llama-server: {}", msg),
            Self::RequestFailed(msg) => write!(f, "Llama request failed: {}", msg),
            Self::ParseError(msg) => write!(f, "Failed to parse LLM response: {}", msg),
        }
    }
}

impl std::error::Error for LlamaError {}

/// Completion request to llama-server.
#[derive(Debug, Serialize)]
struct CompletionRequest {
    prompt: String,
    n_predict: i32,
    temperature: f32,
    stop: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    n_keep: Option<i32>,
}

/// Completion response from llama-server.
#[derive(Debug, Deserialize)]
struct CompletionResponse {
    content: String,
    stop: String,
}

/// Managed llama-server process.
pub struct LlamaServer {
    child: Option<Child>,
    port: u16,
    base_url: String,
    http: reqwest::Client,
}

impl LlamaServer {
    /// Start llama-server with the given GGUF model.
    /// 
    /// Searches for `llama-server` binary in PATH.
    /// Returns Err if binary not found or server fails to start.
    pub async fn start(gguf_path: &str) -> Result<Arc<RwLock<Self>>, LlamaError> {
        // Find llama-server binary
        let llama_server_bin = which_llama_server()
            .ok_or_else(|| LlamaError::StartFailed(
                "llama-server not found in PATH. Install llama.cpp or add to PATH.".to_string()
            ))?;

        // Start process with port 0 (random available port)
        let mut child = Command::new(&llama_server_bin)
            .args([
                "-m", gguf_path,
                "--port", "0",
                "--host", "127.0.0.1",
                "-c", "2048",        // context size
                "-n", "1024",        // max prediction tokens
                "--temp", "0.1",     // low temp for structured JSON output
                "--log-disable",
                "--no-display-prompt",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| LlamaError::StartFailed(format!("spawn failed: {}", e)))?;

        // Read stderr to find the assigned port
        let stderr = child.stderr.take()
            .ok_or_else(|| LlamaError::StartFailed("no stderr".to_string()))?;
        let port = find_port_from_stderr(stderr).await
            .map_err(|e| LlamaError::StartFailed(format!("could not determine port: {}", e)))?;

        let base_url = format!("http://127.0.0.1:{}", port);
        tracing::info!(%gguf_path, %base_url, "llama-server started");

        let server = Self {
            child: Some(child),
            port,
            base_url: base_url.clone(),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        };

        // Wait for health check
        server.wait_for_ready().await?;

        Ok(Arc::new(RwLock::new(server)))
    }

    /// Generate a completion (raw text response).
    pub async fn complete(&self, prompt: &str) -> Result<String, LlamaError> {
        let url = format!("{}/completion", self.base_url);
        let req = CompletionRequest {
            prompt: prompt.to_string(),
            n_predict: 1024,
            temperature: 0.1,
            stop: vec!["<|im_end|>".to_string(), "<|endoftext|>".to_string()],
            n_keep: Some(0),
        };

        let resp = self.http.post(&url).json(&req).send().await
            .map_err(|e| LlamaError::RequestFailed(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(LlamaError::RequestFailed(format!("{}: {}", status, body)));
        }

        let body: CompletionResponse = resp.json().await
            .map_err(|e| LlamaError::RequestFailed(format!("parse response: {}", e)))?;

        Ok(body.content)
    }

    /// Check if the server is reachable.
    pub async fn health_check(&self) -> bool {
        let url = format!("{}/health", self.base_url);
        self.http.get(&url).send().await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    /// Wait for server to be ready (health check passes).
    async fn wait_for_ready(&self) -> Result<(), LlamaError> {
        for i in 0..MAX_HEALTH_ATTEMPTS {
            if self.health_check().await {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(HEALTH_POLL_INTERVAL_MS)).await;
        }
        Err(LlamaError::StartFailed(format!(
            "server not healthy after {} attempts", MAX_HEALTH_ATTEMPTS
        )))
    }

    /// Kill the server process.
    pub async fn shutdown(&mut self) {
        if let Some(ref mut child) = self.child {
            let _ = child.kill().await;
        }
        self.child = None;
        tracing::info!("llama-server stopped");
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }
}

impl Drop for LlamaServer {
    fn drop(&mut self) {
        if let Some(ref mut child) = self.child {
            // Best-effort kill on drop (non-async context)
            let _ = child.start_kill();
        }
    }
}

/// Find the port assigned by llama-server from stderr output.
async fn find_port_from_stderr(
    stderr: tokio::process::ChildStderr,
) -> Result<u16, String> {
    let reader = tokio::io::BufReader::new(stderr);
    let mut lines = reader.lines();

    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        if let Some(caps) = PORT_RE.captures(&line) {
            let port: u16 = caps[1].parse().map_err(|e| e.to_string())?;
            return Ok(port);
        }
    }
    Err("port not found in llama-server output".to_string())
}

/// Locate llama-server binary in PATH.
fn which_llama_server() -> Option<String> {
    // Check common names: llama-server, llama-server
    for name in &["llama-server", "llama-cli"] {
        if let Ok(output) = std::process::Command::new("which").arg(name).output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Some(path);
                }
            }
        }
    }
    None
}
```

- [ ] **Step 3: Register the module in `src/lib.rs`**

Add `pub mod llama;` near the other module declarations at the top of `src/lib.rs` (find the block of `pub mod` declarations like `pub mod pii;`, `pub mod gateway;`, etc.)

- [ ] **Step 4: Add `llama-server` dependency note to `Cargo.toml`**

No new Rust crate dependencies needed — uses existing `reqwest`, `tokio`, `serde_json`, `regex`, `tracing`, `once_cell`. Just add a comment in `Cargo.toml` near the `llama` feature:

```toml
# Optional LLM PII backend via llama.cpp.
# Requires llama-server (from llama.cpp) in PATH.
# Build llama.cpp: git clone https://github.com/ggerganov/llama.cpp && cmake -B build -DLLAMA_CURL=ON && cmake --build build --config Release
llama = []
```

- [ ] **Step 5: Compile check**

Run: `cargo check -p aelvyril_lib 2>&1 | head -30` (from `src-tauri/` dir)
Expected: May have warnings about unused imports if the module isn't wired yet — that's OK.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/llama/ src-tauri/Cargo.toml
git commit -m "feat(llama): add LlamaServer subprocess manager"
```

---

### Task 2: Create `src/llama/detector.rs` — LlamaDetector with PII extraction

**Files:**
- Create: `src-tauri/src/llama/detector.rs`
- Modify: `src-tauri/src/llama/mod.rs`

- [ ] **Step 1: Create `src/llama/detector.rs`**

This prompts the model using the trained LFM2.5 chat template, parses the JSON output, and maps entity labels to `PiiType`.

```rust
use crate::pii::recognizers::{PiiMatch, PiiType};
use crate::llama::server::{LlamaError, LlamaServer};
use once_cell::sync::Lazy;
use regex::Regex;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing;

/// System prompt matching the model's training.
const SYSTEM_PROMPT: &str = "You are a PII detection engine. Extract all personally identifiable information (PII) from the input text. Output ONLY a valid JSON array of objects with fields: text (string), start (char offset), end (char offset), label (entity type). Do not add commentary, markdown, or explanation.";

/// Regex to extract JSON array from model output (may have surrounding text).
static JSON_ARRAY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\[\s*\{[^]]*\}\s*\]").unwrap()
});

/// Default confidence for LLM-detected entities.
const LLM_CONFIDENCE: f64 = 0.85;

/// PII detector powered by the fine-tuned LFM2.5-350M model via llama-server.
pub struct LlamaDetector {
    server: Arc<RwLock<LlamaServer>>,
}

impl LlamaDetector {
    /// Create a new detector by starting llama-server with the given GGUF model.
    pub async fn new(gguf_path: &str) -> Result<Self, LlamaError> {
        let server = LlamaServer::start(gguf_path).await?;
        Ok(Self { server })
    }

    /// Create a detector from an already-running server (for testing).
    #[cfg(test)]
    pub fn from_server(server: Arc<RwLock<LlamaServer>>) -> Self {
        Self { server }
    }

    /// Detect PII entities in the text using the LLM.
    pub async fn detect(&self, text: &str) -> Result<Vec<PiiMatch>, LlamaError> {
        let prompt = build_prompt(text);
        let server = self.server.read().await;
        let raw = server.complete(&prompt).await?;
        drop(server);
        parse_pii_response(&raw, LLM_CONFIDENCE)
    }

    /// Check if the underlying llama-server is healthy.
    pub async fn is_healthy(&self) -> bool {
        let server = self.server.read().await;
        server.health_check().await
    }

    /// Get the base URL of the llama-server.
    pub async fn base_url(&self) -> String {
        let server = self.server.read().await;
        server.base_url().to_string()
    }
}

/// Build the chat-formatted prompt using LFM2.5's template.
fn build_prompt(text: &str) -> String {
    format!(
        "<|im_start|>system\n{}<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n",
        SYSTEM_PROMPT, text
    )
}

/// Parse the model's JSON output into PiiMatch list.
fn parse_pii_response(raw: &str, confidence: f64) -> Result<Vec<PiiMatch>, LlamaError> {
    // Extract JSON array from potentially noisy output
    let json_str = JSON_ARRAY_RE.find(raw)
        .map(|m| m.as_str())
        .ok_or_else(|| LlamaError::ParseError(format!(
            "no JSON array found in output: {}",
            &raw[..raw.len().min(200)]
        )))?;

    let items: Vec<serde_json::Value> = serde_json::from_str(json_str)
        .map_err(|e| LlamaError::ParseError(format!("JSON parse error: {} (input: {})", e, json_str)))?;

    let mut matches = Vec::new();
    for item in items {
        let text = item.get("text").and_then(|v| v.as_str());
        let start = item.get("start").and_then(|v| v.as_i64());
        let end = item.get("end").and_then(|v| v.as_i64());
        let label = item.get("label").and_then(|v| v.as_str());

        let (text, start, end, label) = match (text, start, end, label) {
            (Some(t), Some(s), Some(e), Some(l)) => (t, s as usize, e as usize, l),
            _ => continue, // Skip malformed entries
        };

        // Clamp start/end to valid range
        let end = end.max(start);
        let end = end.min(text.len() + start);

        matches.push(PiiMatch {
            pii_type: label_to_pii_type(label),
            text: text.to_string(),
            start,
            end,
            confidence,
        });
    }

    Ok(matches)
}

/// Map model output labels to Aelvyril's PiiType enum.
fn label_to_pii_type(label: &str) -> PiiType {
    match label {
        "first_name" | "last_name" => PiiType::Person,
        "email" => PiiType::Email,
        "phone_number" => PiiType::PhoneNumber,
        "street_address" => PiiType::Location,
        "city" | "state" | "country" => PiiType::Location,
        "date_of_birth" => PiiType::Date,
        "ssn" => PiiType::Ssn,
        "credit_debit_card" => PiiType::CreditCard,
        "bank_routing_number" | "account_number" => PiiType::ApiKey,
        "ip_address" => PiiType::IpAddress,
        "url" => PiiType::Domain,
        _ => {
            tracing::debug!(%label, "Unknown PII label from LLM, mapping to ApiKey");
            PiiType::ApiKey
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_prompt_contains_system_and_user() {
        let prompt = build_prompt("Hello John at test@example.com");
        assert!(prompt.contains("<|im_start|>system"));
        assert!(prompt.contains(SYSTEM_PROMPT));
        assert!(prompt.contains("<|im_start|>user"));
        assert!(prompt.contains("Hello John at test@example.com"));
        assert!(prompt.contains("<|im_start|>assistant"));
    }

    #[test]
    fn test_parse_valid_json_response() {
        let raw = r#"[{"text": "John", "start": 0, "end": 4, "label": "first_name"}, {"text": "test@example.com", "start": 20, "end": 36, "label": "email"}]"#;
        let matches = parse_pii_response(raw, 0.85).unwrap();
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].pii_type, PiiType::Person);
        assert_eq!(matches[0].text, "John");
        assert_eq!(matches[0].start, 0);
        assert_eq!(matches[0].end, 4);
        assert_eq!(matches[1].pii_type, PiiType::Email);
        assert_eq!(matches[1].text, "test@example.com");
    }

    #[test]
    fn test_parse_json_with_surrounding_text() {
        let raw = r#"Here are the entities: [{"text": "555-1234", "start": 10, "end": 18, "label": "phone_number"}] done."#;
        let matches = parse_pii_response(raw, 0.85).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].pii_type, PiiType::PhoneNumber);
    }

    #[test]
    fn test_parse_empty_result() {
        let raw = r#"[]"#;
        let matches = parse_pii_response(raw, 0.85).unwrap();
        assert!(matches.is_empty());
    }

    #[test]
    fn test_parse_no_json_fails() {
        let raw = "I couldn't find any PII in this text.";
        let result = parse_pii_response(raw, 0.85);
        assert!(result.is_err());
    }

    #[test]
    fn test_label_to_pii_type() {
        assert_eq!(label_to_pii_type("first_name"), PiiType::Person);
        assert_eq!(label_to_pii_type("last_name"), PiiType::Person);
        assert_eq!(label_to_pii_type("email"), PiiType::Email);
        assert_eq!(label_to_pii_type("phone_number"), PiiType::PhoneNumber);
        assert_eq!(label_to_pii_type("ssn"), PiiType::Ssn);
        assert_eq!(label_to_pii_type("credit_debit_card"), PiiType::CreditCard);
        assert_eq!(label_to_pii_type("ip_address"), PiiType::IpAddress);
        assert_eq!(label_to_pii_type("unknown_label"), PiiType::ApiKey);
    }
}
```

- [ ] **Step 2: Update `src/llama/mod.rs` to export detector**

```rust
pub mod detector;
pub mod server;

pub use detector::LlamaDetector;
pub use server::LlamaServer;
```

- [ ] **Step 3: Run unit tests**

Run: `cargo test -p aelvyril_lib llama::detector 2>&1 | tail -20`
Expected: All 6 tests pass (build_prompt, parse_valid, parse_surrounding, parse_empty, parse_no_json, label_mapping)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/llama/
git commit -m "feat(llama): add LlamaDetector with PII extraction and tests"
```

---

### Task 3: Wire LlamaDetector into PiiEngine as Layer 0

**Files:**
- Modify: `src-tauri/src/pii/engine.rs`
- Modify: `src-tauri/src/state.rs`

- [ ] **Step 1: Add LlamaDetector to PiiEngine**

In `src/pii/engine.rs`, add a llama server field behind the `llama` feature flag:

At the top of `engine.rs`, add the feature-gated import:

```rust
#[cfg(feature = "llama")]
use crate::llama::LlamaDetector;
```

In the `PiiEngine` struct definition, add the field:

```rust
#[derive(Clone)]
pub struct PiiEngine {
    allow_patterns: Vec<regex::Regex>,
    deny_patterns: Vec<regex::Regex>,
    presidio: PresidioClient,
    /// LLM-based PII detection via fine-tuned LFM2.5 (feature-gated)
    #[cfg(feature = "llama")]
    llama: Option<Arc<tokio::sync::RwLock<LlamaDetector>>>,
}
```

Update `Default` and `new()`:

```rust
impl Default for PiiEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl PiiEngine {
    pub fn new() -> Self {
        Self {
            allow_patterns: Vec::new(),
            deny_patterns: Vec::new(),
            presidio: PresidioClient::new("http://localhost:3000".into(), true),
            #[cfg(feature = "llama")]
            llama: None,
        }
    }
```

Add a method to initialize the LLM backend:

```rust
    /// Initialize the LLM PII detection backend with a GGUF model.
    /// Must be called before `detect()` for LLM detection to work.
    #[cfg(feature = "llama")]
    pub async fn init_llama(&mut self, gguf_path: &str) -> Result<(), String> {
        let detector = LlamaDetector::new(gguf_path).await.map_err(|e| e.to_string())?;
        self.llama = Some(Arc::new(tokio::sync::RwLock::new(detector)));
        tracing::info!("LLM PII backend initialized");
        Ok(())
    }

    /// Check if the LLM backend is enabled and healthy.
    #[cfg(feature = "llama")]
    pub async fn llama_healthy(&self) -> bool {
        if let Some(ref llama) = self.llama {
            let llama = llama.read().await;
            llama.is_healthy().await
        } else {
            false
        }
    }
```

- [ ] **Step 2: Add LLM as Layer 0 in `detect()` method**

In the `detect` method, add the LLM layer **before** Presidio:

```rust
    pub async fn detect(&self, text: &str) -> Vec<PiiMatch> {
        let mut matches: Vec<PiiMatch> = Vec::new();

        // Layer 0: LLM-based detection (feature-gated)
        #[cfg(feature = "llama")]
        if let Some(ref llama) = self.llama {
            match llama.read().await.detect(text).await {
                Ok(llm_matches) => {
                    for m in llm_matches {
                        if !self.is_allowed(&m.text) {
                            matches.push(m);
                        }
                    }
                    tracing::debug!(count = llm_matches.len(), "LLM detected {} entities", llm_matches.len());
                }
                Err(e) => {
                    tracing::warn!("LLM detection failed, falling back to other layers: {}", e);
                }
            }
        }

        // Layer 1: Presidio (primary NLP-based detection)
        if let Some(presidio_matches) = self.presidio.analyze(text, MIN_CONFIDENCE).await {
            for m in presidio_matches {
                if !self.is_allowed(&m.text) {
                    matches.push(m);
                }
            }
        }

        // Layer 2: Custom recognizers (safety layer — always runs)
        // ... (existing code unchanged)
```

- [ ] **Step 3: Initialize LLM during bootstrap**

In `src/bootstrap/setup.rs`, find where `PiiEngine::new()` is called (around line 91 in state.rs or setup.rs) and add initialization:

In `src/state.rs` where `PiiEngine::new()` is called (line ~91), add after the engine is created:

```rust
#[cfg(feature = "llama")]
{
    let default_gguf = dirs::data_dir()
        .map(|d| d.join("aelvyril").join("models").join("pii-q4_k_m.gguf"))
        .or_else(|| Some(std::path::PathBuf::from("model-q4_k_m.gguf")));
    
    if let Some(gguf_path) = default_gguf.as_ref() {
        if gguf_path.exists() {
            match pii_engine.init_llama(gguf_path.to_str().unwrap()).await {
                Ok(()) => tracing::info!("LLM PII backend loaded from {:?}", gguf_path),
                Err(e) => tracing::warn!("Failed to init LLM backend: {}", e),
            }
        }
    }
}
```

- [ ] **Step 4: Compile check with feature flag**

Run: `cargo check -p aelvyril_lib --features llama 2>&1 | tail -20`
Expected: Compiles (may warn about unused code in non-llama paths)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pii/engine.rs src-tauri/src/state.rs
git commit -m "feat(llama): wire LlamaDetector into PiiEngine as Layer 0"
```

---

### Task 4: Update benchmark.rs to use the new LlamaDetector

**Files:**
- Modify: `src-tauri/src/benchmark.rs`

- [ ] **Step 1: Replace the existing llama_backend with the real implementation**

In `src/benchmark.rs`, replace the `#[cfg(feature = "llama")]` block (around line 179):

```rust
#[cfg(feature = "llama")]
mod llama_backend {
    use super::*;
    use crate::llama::LlamaDetector;

    pub struct LlamaDetector {
        inner: crate::llama::LlamaDetector,
    }

    impl LlamaDetector {
        pub async fn new(gguf_path: &str) -> Result<Self, String> {
            let inner = crate::llama::LlamaDetector::new(gguf_path)
                .await
                .map_err(|e| e.to_string())?;
            Ok(Self { inner })
        }
    }

    #[async_trait::async_trait]
    impl Detector for LlamaDetector {
        async fn detect(&self, text: &str) -> Result<Vec<PiiMatch>, String> {
            self.inner.detect(text).await.map_err(|e| e.to_string())
        }
    }
}
```

- [ ] **Step 2: Verify compilation**

Run: `cargo check -p aelvyril_lib --features llama 2>&1 | tail -10`
Expected: Compiles cleanly

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/benchmark.rs
git commit -m "feat(llama): update benchmark to use real LlamaDetector"
```

---

### Task 5: Integration smoke test

**Files:**
- Modify: None (test existing setup)

- [ ] **Step 1: Build llama-server**

```bash
cd /tmp
git clone --depth 1 https://github.com/ggerganov/llama.cpp
cd llama.cpp
cmake -B build -DLLAMA_CURL=ON
cmake --build build --config Release -j$(nproc)
```

- [ ] **Step 2: Add llama-server build to PATH**

```bash
export PATH="/tmp/llama.cpp/build/bin:$PATH"
llama-server --help | head -3
```

- [ ] **Step 3: Copy GGUF model to expected location**

```bash
mkdir -p ~/.local/share/aelvyril/models
cp ~/Documents/GulanesKorp/huggingface/hub/gguf-pii-lfm350m/model-q4_k_m.gguf ~/.local/share/aelvyril/models/pii-q4_k_m.gguf
```

- [ ] **Step 4: Run unit tests**

```bash
cd ~/Documents/GulanesKorp/Aelvyril/src-tauri
cargo test -p aelvyril_lib llama:: --features llama 2>&1 | tail -20
```

- [ ] **Step 5: End-to-end test — run Aelvyril with LLM backend**

```bash
cargo run --features llama 2>&1 | grep -i "llama\|pii\|backend"
```

Expected: Log line: `"LLM PII backend loaded from ..."`

- [ ] **Step 6: Commit any config or path fixes**

```bash
git add -A
git commit -m "feat(llama): integration smoke test passing"
```

---

## Self-Review

1. **Spec coverage:** LlamaServer subprocess ✓, LlamaDetector with chat template ✓, PiiEngine integration as Layer 0 ✓, benchmark wiring ✓, label mapping ✓, feature flag ✓

2. **Placeholder scan:** No TBDs, no "add error handling" without code, all types defined, all file paths explicit

3. **Type consistency:** `PiiMatch` struct reused from existing `recognizers.rs`, `PiiType` enum reused, `LlamaDetector` returns `Result<Vec<PiiMatch>, LlamaError>` consistent with benchmark's `Detector` trait

4. **Architecture alignment:** Follows Presidio pattern (subprocess + HTTP client), fits into existing layered detection in PiiEngine, feature-gated behind existing `llama` flag
