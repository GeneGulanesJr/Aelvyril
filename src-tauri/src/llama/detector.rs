use crate::pii::recognizers::{PiiMatch, PiiType};
use crate::llama::server::{LlamaError, LlamaServer};
use once_cell::sync::Lazy;
use regex::Regex;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing;

/// System prompt matching the fine-tuned model's training format.
const SYSTEM_PROMPT: &str = "You are a PII detection engine. Extract all personally \
identifiable information (PII) from the input text. Output ONLY a valid JSON array of \
objects with fields: text (string), start (char offset), end (char offset), label \
(entity type). Do not add commentary, markdown, or explanation.";

/// Regex to extract a JSON array (including empty `[]`) from potentially noisy model output.
static JSON_ARRAY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\[(?:\s*\{[^]]*\}\s*)*\]").unwrap()
});

/// Default confidence for LLM-detected entities.
const LLM_CONFIDENCE: f64 = 0.85;

/// PII detector powered by the fine-tuned LFM2.5-350M model via llama-server.
pub struct LlamaDetector {
    server: Arc<RwLock<LlamaServer>>,
    // Path to the model directory (for Python chat-template helper)
    model_dir: String,
}

impl LlamaDetector {
    /// Create a new detector by starting llama-server with the given GGUF model.
    /// `gguf_path` is the full path to the .gguf file — we derive the model directory
    /// from it (parent directory containing tokenizer.json) for the chat template.
    pub async fn new(gguf_path: &str) -> Result<Self, LlamaError> {
        // Make SYSTEM_PROMPT available to the Python chat-template helper
        std::env::set_var("SYSTEM_PROMPT", SYSTEM_PROMPT);
        let server = LlamaServer::start(gguf_path).await?;
        // Derive model_dir: parent of the GGUF file (typically .../models--LiquidAI--LFM2.5-350M/snapshots/<sha>/)
        let model_dir = std::path::Path::new(gguf_path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "".to_string());
        Ok(Self { server, model_dir })
    }

    /// Detect PII entities in the text using the LLM.
    pub async fn detect(&self, text: &str) -> Result<Vec<PiiMatch>, LlamaError> {
        let prompt = build_prompt(text, &self.model_dir)?;
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

/// Build the chat-formatted prompt using the model's tokenizer template.
/// Prefers the Python venv helper (via `uv run` if .venv exists), falls back to ChatML on error.
fn build_prompt(text: &str, model_dir: &str) -> Result<String, LlamaError> {
    let system_prompt = std::env::var("SYSTEM_PROMPT").map_err(|_| {
        LlamaError::PromptBuildFailed("SYSTEM_PROMPT environment variable not set".into())
    })?;

    // Resolve helper path: $CARGO_MANIFEST_DIR/src/llama/prompt_helper.py
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let helper_path = manifest_dir.join("src").join("llama").join("prompt_helper.py");

    // Resolve venv: $CARGO_MANIFEST_DIR/.venv/bin/python
    let venv_dir = manifest_dir.join(".venv");
    let venv_python = venv_dir.join("bin").join("python");

    // Decide whether to use `uv run --python <venv_python>` or plain `python3`
    let (cmd, args): (std::path::PathBuf, Vec<std::path::PathBuf>) = if venv_python.exists() {
        // Use uv run to execute within the venv (mirrors presidio_service)
        (std::path::PathBuf::from("uv"), {
            let mut v = Vec::new();
            v.push(std::path::PathBuf::from("run"));
            v.push(std::path::PathBuf::from("--python"));
            v.push(venv_python);
            v.push(helper_path.clone());
            v.push(PathBuf::from(model_dir));
            v.push(PathBuf::from(text));
            v
        })
    } else {
        // Fallback: system python3
        (std::path::PathBuf::from("python3"), {
            let mut v = Vec::new();
            v.push(helper_path);
            v.push(PathBuf::from(model_dir));
            v.push(PathBuf::from(text));
            v
        })
    };

    let output = Command::new(&cmd)
        .args(&args)
        .env("SYSTEM_PROMPT", &system_prompt)
        .output()
        .map_err(|e| LlamaError::PromptBuildFailed(format!(
            "Failed to spawn prompt_helper.py via {cmd:?}: {e}"
        )))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let err = String::from_utf8_lossy(&output.stderr);
        tracing::warn!(%err, "prompt_helper.py failed — falling back to ChatML");
        Ok(format!(
            "system\n{SYSTEM_PROMPT}\n\nuser\n{text}\n\nassistant\n",
            SYSTEM_PROMPT = SYSTEM_PROMPT,
            text = text,
        ))
    }
}
/// Parse the model's JSON output into a list of `PiiMatch`.
fn parse_pii_response(raw: &str, confidence: f64) -> Result<Vec<PiiMatch>, LlamaError> {
    // Extract JSON array from potentially noisy output
    let json_str = JSON_ARRAY_RE.find(raw).map(|m| m.as_str()).ok_or_else(|| {
        LlamaError::ParseError(format!(
            "no JSON array found in output: {}",
            &raw[..raw.len().min(200)]
        ))
    })?;

    let items: Vec<serde_json::Value> = serde_json::from_str(json_str).map_err(|e| {
        LlamaError::ParseError(format!(
            "JSON parse error: {} (input: {})",
            e,
            &json_str[..json_str.len().min(200)]
        ))
    })?;

    let mut matches = Vec::new();
    for item in items {
        let text_val = item.get("text").and_then(|v| v.as_str());
        let start_val = item.get("start").and_then(|v| v.as_i64());
        let end_val = item.get("end").and_then(|v| v.as_i64());
        let label_val = item.get("label").and_then(|v| v.as_str());

        let (text, start, end, label) = match (text_val, start_val, end_val, label_val) {
            (Some(t), Some(s), Some(e), Some(l)) => (t, s as usize, e as usize, l),
            _ => continue,
        };

        // Clamp start/end to sane range
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

/// Map model output labels to Aelvyril's `PiiType` enum.
fn label_to_pii_type(label: &str) -> PiiType {
    match label {
        "first_name" | "last_name" => PiiType::Person,
        "email" | "email_address" => PiiType::Email,
        "phone_number" => PiiType::PhoneNumber,
        "street_address" => PiiType::Location,
        "city" | "state" | "country" | "zip_code" => PiiType::Location,
        "date_of_birth" | "date" => PiiType::Date,
        "ssn" => PiiType::Ssn,
        "credit_debit_card" | "credit_card" => PiiType::CreditCard,
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
        // Set SYSTEM_PROMPT env var (required by new build_prompt signature)
        std::env::set_var("SYSTEM_PROMPT", SYSTEM_PROMPT);
        // model_dir is ignored in fallback path, but must be provided
        let prompt = build_prompt("Hello John at test@example.com", "/tmp/model").unwrap();
        assert!(prompt.contains("system"));
        assert!(prompt.contains(SYSTEM_PROMPT));
        assert!(prompt.contains("user"));
        assert!(prompt.contains("Hello John at test@example.com"));
        assert!(prompt.contains("assistant"));
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
        assert_eq!(label_to_pii_type("email_address"), PiiType::Email);
        assert_eq!(label_to_pii_type("phone_number"), PiiType::PhoneNumber);
        assert_eq!(label_to_pii_type("ssn"), PiiType::Ssn);
        assert_eq!(label_to_pii_type("credit_debit_card"), PiiType::CreditCard);
        assert_eq!(label_to_pii_type("credit_card"), PiiType::CreditCard);
        assert_eq!(label_to_pii_type("ip_address"), PiiType::IpAddress);
        assert_eq!(label_to_pii_type("city"), PiiType::Location);
        assert_eq!(label_to_pii_type("state"), PiiType::Location);
        assert_eq!(label_to_pii_type("date_of_birth"), PiiType::Date);
        assert_eq!(label_to_pii_type("unknown_label"), PiiType::ApiKey);
    }

    #[test]
    fn test_parse_skips_malformed_entries() {
        // Missing "label" field — should skip the entry, not error
        let raw = r#"[{"text": "John", "start": 0, "end": 4}, {"text": "555-1234", "start": 5, "end": 13, "label": "phone_number"}]"#;
        let matches = parse_pii_response(raw, 0.85).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].pii_type, PiiType::PhoneNumber);
    }

    #[test]
    fn test_parse_clamps_end_to_start() {
        // end < start should be clamped
        let raw = r#"[{"text": "ab", "start": 5, "end": 2, "label": "email"}]"#;
        let matches = parse_pii_response(raw, 0.85).unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].start, 5);
        assert_eq!(matches[0].end, 5);
    }
}
