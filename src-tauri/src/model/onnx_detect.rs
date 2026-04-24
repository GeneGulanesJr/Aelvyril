//! ONNX-based PII detection using LFM2.5-350M.
//!
//! When the `onnx` feature is enabled and a model file is available, this module
//! loads the ONNX model and runs inference to detect PII entities in text.
//! When unavailable, the heuristic classifier in `mod.rs` is used instead.
//!
//! **Model**: [`LiquidAI/LFM2.5-350M-ONNX`](https://huggingface.co/LiquidAI/LFM2.5-350M-ONNX)
//! **Recommended variant**: `model_q4f16.onnx` (~255 MB, best size-to-quality for CPU)
//! **Runtime**: `ort` crate v2.0 (Rust wrapper for ONNX Runtime)

// ── PII Detection Prompt ──────────────────────────────────────────────────────

/// The system prompt for PII detection. Instructs the model to output structured JSON
/// with detected entities.
#[allow(dead_code)]
const PII_DETECTION_SYSTEM_PROMPT: &str = r#"You are a PII detection system. Analyze the given text and identify all personally identifiable information (PII) entities. For each entity, output a JSON array where each item has:
- "type": one of Person, Email, PhoneNumber, IPAddress, Domain, APIKey, CreditCard, SSN, IBAN, Date, Location, Organization
- "text": the exact text span
- "start": character offset (0-based) of the start of the entity
- "end": character offset of the end of the entity (exclusive)
- "confidence": float between 0.0 and 1.0

Output ONLY the JSON array, no other text. If no PII is found, output an empty array [].
Do not flag example, test, placeholder, or obviously fake data (e.g., test@example.com, 000-00-0000)."#;

/// The user prompt template.
#[allow(dead_code)]
const PII_DETECTION_USER_TEMPLATE: &str = "Analyze this text for PII entities:\n\n";

/// Maximum text length to send to the model (characters). Text longer than this
/// is truncated to avoid exceeding the model's context window.
#[allow(dead_code)]
const MAX_INPUT_CHARS: usize = 4000;

/// Maximum tokens for the model to generate (output length budget).
#[allow(dead_code)]
const MAX_OUTPUT_TOKENS: usize = 512;

/// Temperature for generation (0.0 = greedy, higher = more random).
/// Lower values produce more deterministic output — good for structured JSON detection.
#[allow(dead_code)]
const GENERATION_TEMPERATURE: f32 = 0.3;

/// Top-p (nucleus) sampling threshold. Only consider tokens whose cumulative
/// probability falls within this threshold.
#[allow(dead_code)]
const GENERATION_TOP_P: f32 = 0.9;

/// Early stopping: if no new non-whitespace content produced after this many
/// tokens, stop generating (model is "stuck").
#[allow(dead_code)]
const GENERATION_STUCK_LIMIT: usize = 50;

/// Default confidence threshold below which model detections are discarded.
const DEFAULT_ONNX_CONFIDENCE: f64 = 0.4;

/// EOS token ID for LFM2.5 (standard Llama tokenizer EOS).
#[allow(dead_code)]
const EOS_TOKEN_ID: i64 = 2;

// ── ONNX Model Entity Types ──────────────────────────────────────────────────

/// A PII entity detected by the ONNX model.
#[derive(Debug, Clone)]
pub struct OnnxDetection {
    /// The entity type label from the model.
    pub entity_type: String,
    /// The exact text span that was detected.
    pub text: String,
    /// Character offset of the start of the entity.
    pub start: usize,
    /// Character offset of the end of the entity (exclusive).
    pub end: usize,
    /// Model confidence score [0.0, 1.0].
    pub confidence: f64,
}

// ── Full ONNX Implementation (feature = "onnx") ─────────────────────────────

#[cfg(feature = "onnx")]
mod onnx_impl {
    use super::*;
    use ort::session::{Session, SessionInputValue};
    use ort::value::TensorRef;
    use std::path::PathBuf;
    use std::sync::Arc;

    pub struct OnnxModelServiceImpl {
        session: Arc<parking_lot::RwLock<Option<Session>>>,
        model_path: PathBuf,
        tokenizer_path: PathBuf,
        loaded: Arc<std::sync::atomic::AtomicBool>,
        executor: Arc<super::executor::InferenceExecutor>,
        confidence_threshold: Arc<std::sync::atomic::AtomicU64>,
    }

    impl OnnxModelServiceImpl {
        pub fn new(model_path: PathBuf, tokenizer_path: PathBuf) -> Self {
            Self {
                session: Arc::new(parking_lot::RwLock::new(None)),
                model_path,
                tokenizer_path,
                loaded: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                executor: Arc::new(super::executor::InferenceExecutor::new()),
                confidence_threshold: Arc::new(std::sync::atomic::AtomicU64::new(
                    DEFAULT_ONNX_CONFIDENCE.to_bits(),
                )),
            }
        }

        /// Get the current confidence threshold.
        pub fn confidence_threshold(&self) -> f64 {
            f64::from_bits(
                self.confidence_threshold
                    .load(std::sync::atomic::Ordering::Relaxed),
            )
        }

        /// Set the confidence threshold (0.0 = catch everything, 1.0 = only high confidence).
        pub fn set_confidence_threshold(&self, threshold: f64) {
            let clamped = threshold.clamp(0.0, 1.0);
            self.confidence_threshold
                .store(clamped.to_bits(), std::sync::atomic::Ordering::Relaxed);
        }

        pub fn is_loaded(&self) -> bool {
            self.loaded.load(std::sync::atomic::Ordering::Relaxed)
        }

        pub async fn load_model(&self) -> Result<(), String> {
            if !self.model_path.exists() {
                return Err(format!(
                    "Model file not found: {:?}. Using heuristic classifier.",
                    self.model_path
                ));
            }

            tracing::info!("Loading ONNX model from {:?}...", self.model_path);

            let session = Session::builder()
                .map_err(|e| format!("Failed to create ONNX session builder: {}", e))?
                .commit_from_file(&self.model_path)
                .map_err(|e| format!("Failed to load ONNX model from {:?}: {}", self.model_path, e))?;

            *self.session.write() = Some(session);
            self.loaded.store(true, std::sync::atomic::Ordering::Relaxed);

            tracing::info!("ONNX model loaded successfully from {:?}", self.model_path);
            Ok(())
        }

        /// Ensure model is downloaded and loaded. Downloads from HuggingFace
        /// on first call if the model file is not present.
        pub async fn ensure_model(
            &self,
            progress: Option<super::super::downloader::ProgressCallback>,
        ) -> Result<(), String> {
            if self.is_loaded() {
                return Ok(());
            }

            // Download if model file is not present
            if !self.model_path.exists() {
                let model_dir = self
                    .model_path
                    .parent()
                    .ok_or("Invalid model path: no parent directory")?;
                let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
                super::super::downloader::download_model(model_dir, progress, cancel).await?;
            }

            self.load_model().await
        }

        pub async fn detect_pii(&self, text: &str) -> Vec<OnnxDetection> {
            if !self.is_loaded() {
                return Vec::new();
            }

            let input_text = if text.len() > MAX_INPUT_CHARS {
                text[..MAX_INPUT_CHARS].to_string()
            } else {
                text.to_string()
            };

            let prompt = format!(
                "{}\n\n{}{}",
                PII_DETECTION_SYSTEM_PROMPT,
                PII_DETECTION_USER_TEMPLATE,
                input_text
            );

            let text_for_parse = text.to_string();
            let threshold = self.confidence_threshold();
            let session = Arc::clone(&self.session);
            let tokenizer_path = self.tokenizer_path.clone();

            // Offload CPU-bound inference to background thread pool.
            // The session lock is acquired inside the executor via blocking_write,
            // which is safe because the executor thread is not a tokio thread.
            let result = self.executor.spawn(move || {
                let mut session_guard = session.write();
                let session = match session_guard.as_mut() {
                    Some(s) => s,
                    None => return Err("Model not loaded".into()),
                };
                run_inference_sync(session, &tokenizer_path, &prompt)
            }).await;

            match result {
                Ok(output_text) => parse_detections(&output_text, &text_for_parse, threshold),
                Err(e) => {
                    tracing::warn!("ONNX inference failed: {}. Using heuristic fallback.", e);
                    Vec::new()
                }
            }
        }

        /// Synchronous inference function — runs on the background executor thread.
        /// Separated from the async context so it can be called via `spawn()`.
        fn run_inference_sync(
            session: &Session,
            tokenizer_path: &Path,
            prompt: &str,
        ) -> Result<String, String> {
            // Tokenize input
            let tokenizer = tokenizers::Tokenizer::from_file(tokenizer_path)
                .map_err(|e| format!("Failed to load tokenizer: {}", e))?;

            let encoding = tokenizer
                .encode(prompt, true)
                .map_err(|e| format!("Tokenization failed: {}", e))?;

            let input_ids: Vec<i64> = encoding.get_ids().iter().map(|&id| id as i64).collect();
            let attention_mask: Vec<i64> =
                encoding.get_attention_mask().iter().map(|&m| m as i64).collect();
            let initial_len = input_ids.len();

            // Mutable generation state — grow token by token
            let mut generated_ids = input_ids;
            let mut generated_tokens: Vec<String> = Vec::new();
            let mut tokens_since_new_content: usize = 0;
            let mut rng = rand::rng();

            for step in 0..MAX_OUTPUT_TOKENS {
                let seq_len = generated_ids.len();

                // Build input tensors
                let input_ids_arr = ndarray::Array2::from_shape_vec(
                    (1, seq_len),
                    generated_ids.clone(),
                )
                .map_err(|e| format!("Failed to shape input_ids at step {}: {}", step, e))?;
                let attention_mask_arr = ndarray::Array2::from_shape_vec(
                    (1, seq_len),
                    attention_mask.clone(),
                )
                .map_err(|e| {
                    format!("Failed to shape attention_mask at step {}: {}", step, e)
                })?;

                let input_ids_value = TensorRef::from_array_view(&input_ids_arr)
                    .map_err(|e| format!("Failed to create input_ids tensor: {}", e))?
                    .into();
                let attention_mask_value = TensorRef::from_array_view(&attention_mask_arr)
                    .map_err(|e| format!("Failed to create attention_mask tensor: {}", e))?
                    .into();

                let inputs: Vec<(&str, SessionInputValue<'_>)> = vec![
                    ("input_ids", input_ids_value),
                    ("attention_mask", attention_mask_value),
                ];

                // Run single forward pass
                let outputs = session
                    .run(inputs)
                    .map_err(|e| format!("ONNX inference failed at step {}: {}", step, e))?;

                // Extract logits: shape (1, seq_len, vocab_size)
                let logits_output = outputs
                    .get("logits")
                    .or_else(|| outputs.keys().next().and_then(|k| outputs.get(k)))
                    .ok_or("No logits output from model")?;

                let logits_tensor = logits_output
                    .try_extract_tensor::<f32>()
                    .map_err(|e| format!("Failed to extract logits tensor: {}", e))?;

                let logits_shape = logits_tensor.shape().to_vec();
                let ndim = logits_shape.len();

                if ndim < 2 {
                    return Err(format!("Unexpected logits shape: {:?}", logits_shape));
                }

                let vocab_size = logits_shape[ndim - 1];
                let logits_view = logits_tensor.view();

                // Extract logits for the last token position only
                let mut last_logits: Vec<f32> = vec![0.0f32; vocab_size];
                for v in 0..vocab_size {
                    // Build index: [0, ..., seq_len-1, v] depending on dimensionality
                    let idx = if ndim == 3 {
                        logits_view[[0, seq_len - 1, v]]
                    } else if ndim == 2 {
                        logits_view[[seq_len - 1, v]]
                    } else {
                        logits_view[[v]]
                    };
                    last_logits[v] = idx;
                }

                // Sample next token
                let next_token_id = sample_next_token(&last_logits, &mut rng)?;

                // Check for EOS
                if next_token_id == EOS_TOKEN_ID {
                    tracing::debug!("EOS at step {}", step);
                    break;
                }

                // Decode token to text
                if let Ok(decoded) = tokenizer.decode(&[next_token_id as u32], false) {
                    let is_content = !decoded.trim().is_empty();
                    if is_content {
                        tokens_since_new_content = 0;
                    } else {
                        tokens_since_new_content += 1;
                    }
                    generated_tokens.push(decoded);
                } else {
                    tokens_since_new_content += 1;
                }

                // Early stopping: model is producing no useful content
                if tokens_since_new_content >= GENERATION_STUCK_LIMIT {
                    tracing::debug!(
                        "Early stopping at step {}: {} tokens without new content",
                        step,
                        tokens_since_new_content
                    );
                    break;
                }

                // Append to sequence for next iteration
                generated_ids.push(next_token_id);
                attention_mask.push(1);
            }

            let output = generated_tokens.join("");
            tracing::debug!(
                "ONNX generated {} tokens (input was {} tokens)",
                generated_tokens.len(),
                initial_len
            );
            Ok(output)
        }
    }
}

#[cfg(feature = "onnx")]
pub use onnx_impl::OnnxModelServiceImpl;

#[cfg(feature = "onnx")]
pub type OnnxModelService = onnx_impl::OnnxModelServiceImpl;

// ── No-ONNX Stub ────────────────────────────────────────────────────────────

#[cfg(not(feature = "onnx"))]
pub struct OnnxModelService;

#[cfg(not(feature = "onnx"))]
impl OnnxModelService {
    pub fn new(_model_path: std::path::PathBuf, _tokenizer_path: std::path::PathBuf) -> Self {
        Self
    }

    pub fn is_loaded(&self) -> bool {
        false
    }

    pub fn confidence_threshold(&self) -> f64 {
        DEFAULT_ONNX_CONFIDENCE
    }

    pub fn set_confidence_threshold(&self, _threshold: f64) {
        // No-op when ONNX feature is disabled
    }

    pub async fn load_model(&self) -> Result<(), String> {
        Err("ONNX feature is not enabled. Build with --features onnx to enable model inference.".into())
    }

    pub async fn detect_pii(&self, _text: &str) -> Vec<OnnxDetection> {
        Vec::new()
    }
}

// ── JSON Parsing (shared between onnx and stub) ──────────────────────────────

/// Parse the model's JSON output into structured PII detections.
#[allow(dead_code)]
fn parse_detections(model_output: &str, original_text: &str, min_confidence: f64) -> Vec<OnnxDetection> {
    let json_start = match model_output.find('[') {
        Some(i) => i,
        None => return Vec::new(),
    };
    let json_end = match model_output.rfind(']') {
        Some(i) => i + 1,
        None => return Vec::new(),
    };
    let json_str = &model_output[json_start..json_end];

    let parsed: Vec<serde_json::Value> = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(e) => {
            tracing::debug!("Failed to parse ONNX model output as JSON: {}", e);
            return Vec::new();
        }
    };

    let mut detections = Vec::new();
    for item in &parsed {
        let entity_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("Unknown");
        let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("");
        let start = item.get("start").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let end = item.get("end").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let confidence = item.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.5);

        // Validate the span actually exists in the original text
        if start >= original_text.len() || end > original_text.len() || start >= end {
            continue;
        }

        // Verify the detected text matches the span
        let actual_text = &original_text[start..end];
        if actual_text != text && !text.is_empty() {
            // Try to find the text in the original and use that position
            if let Some(pos) = original_text.find(text) {
                detections.push(OnnxDetection {
                    entity_type: entity_type.to_string(),
                    text: text.to_string(),
                    start: pos,
                    end: pos + text.len(),
                    confidence,
                });
            }
        } else {
            detections.push(OnnxDetection {
                entity_type: entity_type.to_string(),
                text: text.to_string(),
                start,
                end,
                confidence,
            });
        }
    }

    // Filter low-confidence detections
    detections.retain(|d| d.confidence >= min_confidence);
    detections
}

/// Sample the next token from logits using temperature + top-p (nucleus) sampling.
///
/// When temperature is 0.0, uses pure greedy decoding (argmax).
/// Otherwise, applies temperature scaling → softmax → top-p filtering → random sample.
#[allow(dead_code)]
fn sample_next_token<R: rand::Rng>(
    logits: &[f32],
    rng: &mut R,
) -> Result<i64, String> {
    if GENERATION_TEMPERATURE <= 0.0 {
        // Pure greedy decoding
        return Ok(logits
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
            .map(|(id, _)| id as i64)
            .unwrap_or(EOS_TOKEN_ID));
    }

    // Apply temperature scaling: softmax(x/T) = softmax(x / T)
    let max_logit = logits.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let scaled: Vec<f32> = logits
        .iter()
        .map(|l| (l - max_logit) / GENERATION_TEMPERATURE)
        .collect();

    // Softmax for numerical stability
    let exp_sum: f32 = scaled.iter().map(|l| l.exp()).sum();
    if exp_sum <= 0.0 || !exp_sum.is_finite() {
        return Err(format!("Invalid softmax sum: {}", exp_sum));
    }
    let probs: Vec<f32> = scaled.iter().map(|l| l.exp() / exp_sum).collect();

    // Top-p (nucleus) filtering: sort by probability descending,
    // keep tokens until cumulative probability >= top_p
    let mut sorted_probs: Vec<(usize, f32)> = probs.iter().cloned().enumerate().collect();
    sorted_probs.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());

    let mut cumulative = 0.0f32;
    let mut filtered: Vec<(usize, f32)> = Vec::new();
    for (idx, p) in sorted_probs {
        cumulative += p;
        filtered.push((idx, p));
        if cumulative >= GENERATION_TOP_P {
            break;
        }
    }

    if filtered.is_empty() {
        return Err("Top-p filtering removed all tokens".into());
    }

    // Renormalize and sample
    let filtered_sum: f32 = filtered.iter().map(|(_, p)| p).sum();
    if filtered_sum <= 0.0 {
        return Err("Filtered probability sum is zero".into());
    }
    let r: f32 = rng.random_range(0.0..filtered_sum);
    let mut acc = 0.0f32;
    let chosen = filtered
        .iter()
        .find(|(_, p)| {
            acc += p;
            acc >= r
        })
        .map(|(id, _)| *id as i64)
        .unwrap_or(EOS_TOKEN_ID);

    Ok(chosen)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_detections_valid_json() {
        let output = r#"[{"type":"Email","text":"john@acme.com","start":8,"end":21,"confidence":0.95}]"#;
        let detections = parse_detections(output, "Send to john@acme.com please", DEFAULT_ONNX_CONFIDENCE);
        assert_eq!(detections.len(), 1);
        assert_eq!(detections[0].entity_type, "Email");
        assert_eq!(detections[0].text, "john@acme.com");
        assert_eq!(detections[0].start, 8); // "john" starts at index 8
        assert_eq!(detections[0].end, 21);
        assert!((detections[0].confidence - 0.95).abs() < 0.01);
    }

    #[test]
    fn test_parse_detections_with_surrounding_text() {
        let output = r#"I found: [{"type":"PhoneNumber","text":"555-1234","start":8,"end":16,"confidence":0.8}]"#;
        let detections = parse_detections(output, "Call 555-1234 now", DEFAULT_ONNX_CONFIDENCE);
        assert_eq!(detections.len(), 1);
        assert_eq!(detections[0].entity_type, "PhoneNumber");
    }

    #[test]
    fn test_parse_detections_empty_array() {
        let output = "[]";
        let detections = parse_detections(output, "No PII here", DEFAULT_ONNX_CONFIDENCE);
        assert!(detections.is_empty());
    }

    #[test]
    fn test_parse_detections_invalid_json() {
        let output = "This is not JSON";
        let detections = parse_detections(output, "Some text", DEFAULT_ONNX_CONFIDENCE);
        assert!(detections.is_empty());
    }

    #[test]
    fn test_parse_detections_low_confidence_filtered() {
        let output = r#"[{"type":"Email","text":"a@b.com","start":0,"end":7,"confidence":0.2}]"#;
        let detections = parse_detections(output, "a@b.com", 0.5);
        assert!(detections.is_empty()); // 0.2 < MIN_ONNX_CONFIDENCE (0.4)
    }

    #[test]
    fn test_parse_detections_span_mismatch_recovery() {
        let output = r#"[{"type":"Person","text":"Alice","start":0,"end":5,"confidence":0.85}]"#;
        let detections = parse_detections(output, "Hello Alice", DEFAULT_ONNX_CONFIDENCE);
        assert_eq!(detections.len(), 1);
        assert_eq!(detections[0].text, "Alice");
        assert_eq!(detections[0].start, 6); // recovered position
        assert_eq!(detections[0].end, 11);
    }

    #[test]
    fn test_no_onnx_feature_stub() {
        let service = OnnxModelService::new(
            std::path::PathBuf::from("/stub"),
            std::path::PathBuf::from("/stub"),
        );
        assert!(!service.is_loaded());
    }

    #[test]
    fn test_sample_next_token_greedy_picks_max() {
        let mut logits = vec![0.0f32; 100];
        logits[42] = 10.0; // clear max
        let mut rng = rand::rng();
        let token = sample_next_token(&logits, &mut rng).unwrap();
        assert_eq!(token, 42);
    }

    #[test]
    fn test_sample_next_token_single_high_prob() {
        // With temperature and top-p, one very high logit should dominate
        let mut logits = vec![0.0f32; 1000];
        logits[7] = 100.0;
        let mut rng = rand::rng();
        let token = sample_next_token(&logits, &mut rng).unwrap();
        assert_eq!(token, 7);
    }

    #[test]
    fn test_sample_next_token_uniform_distribution() {
        // All equal logits — should still produce a valid token
        let logits = vec![1.0f32; 100];
        let mut rng = rand::rng();
        let token = sample_next_token(&logits, &mut rng).unwrap();
        assert!(token >= 0 && token < 100);
    }

    #[test]
    fn test_threshold_getter_setter() {
        let service = OnnxModelService::new(
            std::path::PathBuf::from("/stub"),
            std::path::PathBuf::from("/stub"),
        );
        assert!((service.confidence_threshold() - DEFAULT_ONNX_CONFIDENCE).abs() < 0.01);
        // The stub is a no-op, so we only test the getter returns a valid value.
        // The real setter is tested behind #[cfg(feature = "onnx")] in integration.
    }

    #[test]
    fn test_parse_detections_custom_threshold() {
        let output = r#"[{"type":"Email","text":"a@b.com","start":0,"end":7,"confidence":0.45}]"#;
        // At threshold 0.5, this should be filtered (0.45 < 0.5)
        let detections = parse_detections(output, "a@b.com", 0.5);
        assert!(detections.is_empty());
        // At threshold 0.3, this should pass
        let detections = parse_detections(output, "a@b.com", 0.3);
        assert_eq!(detections.len(), 1);
    }
}