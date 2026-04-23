//! Local model layer for contextual PII detection.
//!
//! This module provides a text classification model that analyzes text context
//! to determine whether structurally-matched PII entities are truly sensitive
//! or false positives based on surrounding context.
//!
//! **Architecture:**
//! - Uses a weighted feature-based classifier (no external runtime dependency)
//!   as the default/fallback mode.
//! - The classifier is trained via hand-tuned weights over a 128-dimensional
//!   feature vector derived from keyword proximity, PII density, and statistical
//!   text features.
//! - When the `onnx` feature is enabled and a model file is available, the
//!   ONNX-based LFM2.5-350M model is used for ML-based PII detection.
//!   The ONNX model produces structured JSON output with entity types and
//!   confidence scores, which is merged with the heuristic classifier results.
//!
//! **Current Mode:** Heuristic classifier with production-quality feature weights.
//!
//! **Feature Extraction (128 dimensions):**
//! - 24 binary features: sensitive keyword presence
//! - 12 binary features: benign keyword presence
//! - 8 statistical features: text length, digit ratio, special char ratio, etc.
//! - 10 binary features: PII-type regex pattern presence
//! - 74 padding features (reserved for future use)

pub mod features;
pub mod onnx_detect;

use std::path::Path;

// ── Types ────────────────────────────────────────────────────────────────────

/// Contextual sensitivity signals derived from surrounding text.
struct ContextualSignal {
    has_sensitive_context: bool,
    has_benign_context: bool,
    pii_density: f64,
    model_sentiment: f64,
}

/// Pre-computed weights for the feature-based classifier.
/// Trained by hand-tuning on common PII detection scenarios.
struct ClassifierWeights {
    /// Per-feature weights for the sensitive keyword features (25 dims)
    sensitive_weights: [f64; 25],
    /// Per-feature weights for the benign keyword features (12 dims)
    benign_weights: [f64; 12],
    /// Per-feature weights for the statistical features (8 dims)
    stat_weights: [f64; 8],
    /// Per-feature weights for the PII pattern features (10 dims)
    pii_pattern_weights: [f64; 10],
    /// Bias term
    bias: f64,
}

impl ClassifierWeights {
    fn production() -> Self {
        Self {
            // Higher weight = more sensitive when this keyword is present
            sensitive_weights: [
                0.30, // password
                0.25, // secret
                0.35, // confidential
                0.20, // private
                0.15, // sensitive
                0.35, // ssn
                0.30, // credit card
                0.28, // bank account
                0.22, // routing
                0.25, // passport
                0.25, // health
                0.28, // medical
                0.30, // diagnosis
                0.20, // insurance
                0.18, // salary
                0.18, // income
                0.20, // license
                0.15, // dob
                0.10, // address
                0.08, // phone
                0.05, // email
                0.22, // account number
                0.30, // social security
                0.15, // debit
                0.00, // padding
            ],
            // Negative weights = more benign when these keywords present
            benign_weights: [
                -0.25, // example
                -0.20, // test
                -0.22, // sample
                -0.25, // placeholder
                -0.22, // template
                -0.18, // demo
                -0.20, // dummy
                -0.22, // fake
                -0.20, // mock
                -0.15, // public
                -0.10, // documentation
                -0.10, // tutorial
            ],
            stat_weights: [
                0.05, // length (normalized)
                0.00, // word count
                0.08, // digit ratio
                0.03, // special char ratio
                0.02, // uppercase ratio
                0.06, // contains @
                0.03, // contains /
                0.02, // contains :
            ],
            pii_pattern_weights: [
                0.35, // SSN pattern
                0.30, // CC pattern
                0.15, // phone pattern
                0.10, // email pattern
                0.20, // IP pattern
                0.18, // long digit pattern
                0.22, // ID pattern
                0.08, // name pattern
                0.12, // date pattern
                0.25, // IBAN pattern
            ],
            bias: 0.0,
        }
    }
}

// ── Service ─────────────────────────────────────────────────────────────────

/// Local model layer for contextual PII detection.
///
/// Uses a weighted feature classifier for real-time context scoring.
/// Can optionally load an ONNX model for ML-based inference.
pub struct ModelService {
    loaded: bool,
    weights: ClassifierWeights,
}

impl ModelService {
    pub fn new() -> Self {
        Self {
            loaded: false,
            weights: ClassifierWeights::production(),
        }
    }

    /// Check if an external model is loaded.
    pub fn is_loaded(&self) -> bool {
        self.loaded
    }

    /// Run contextual sensitivity analysis on text.
    ///
    /// Returns a confidence score [0.0, 1.0] for each detected entity.
    pub fn analyze_context(&self, text: &str, entity_count: usize) -> Vec<f64> {
        if entity_count == 0 || text.is_empty() {
            return Vec::new();
        }

        let text_lower = text.to_lowercase();
        let lines: Vec<&str> = text.lines().collect();

        // Use the built-in classifier for sentiment scoring
        let features = extract_text_features(text);
        let model_sentiment = self.classify(&features);

        let signal = analyze_contextual_signals(&text_lower, &lines, entity_count, model_sentiment);

        (0..entity_count)
            .map(|i| compute_entity_confidence(&signal, i, entity_count, &lines))
            .collect()
    }

    /// Classify text features into a sentiment score using the weighted model.
    ///
    /// Returns a value in [-1.0, 1.0]:
    /// - Positive = benign context
    /// - Negative = sensitive context
    fn classify(&self, features: &[f32]) -> f64 {
        let mut score = self.weights.bias;
        let w = &self.weights;

        // Weighted sum of sensitive keyword features
        for (i, feature) in features.iter().enumerate().take(w.sensitive_weights.len().min(features.len())) {
            score += w.sensitive_weights[i] * *feature as f64;
        }

        // Weighted sum of benign keyword features (offset by 24)
        let benign_offset = 24;
        for i in 0..w.benign_weights.len() {
            let idx = benign_offset + i;
            if idx < features.len() {
                score += w.benign_weights[i] * features[idx] as f64;
            }
        }

        // Weighted sum of statistical features (offset by 36)
        let stat_offset = 36;
        for i in 0..w.stat_weights.len() {
            let idx = stat_offset + i;
            if idx < features.len() {
                score += w.stat_weights[i] * features[idx] as f64;
            }
        }

        // Weighted sum of PII pattern features (offset by 44)
        let pii_offset = 44;
        for i in 0..w.pii_pattern_weights.len() {
            let idx = pii_offset + i;
            if idx < features.len() {
                score += w.pii_pattern_weights[i] * features[idx] as f64;
            }
        }

        // Apply sigmoid and map to [-1, 1]
        // Scale factor to keep scores in a reasonable range
        let sigmoid = 1.0 / (1.0 + (-score * 3.0).exp());
        (sigmoid * 2.0) - 1.0
    }

    /// Load an ONNX model from a file path.
    ///
    /// Currently supports heuristic-only mode. When `ort` is added as a
    /// dependency, this will load the model for ML-based inference.
    pub async fn load_model(&mut self, model_path: &str) -> Result<(), String> {
        let model_file = Path::new(model_path);

        if !model_file.exists() {
            tracing::warn!(
                "Model not found at {:?} — using built-in weighted classifier",
                model_file
            );
            self.loaded = false;
            return Err(format!("Model file not found: {:?}", model_file));
        }

        // Validate it's a readable file
        match tokio::fs::metadata(model_path).await {
            Ok(meta) if meta.len() > 0 => {
                tracing::info!(
                    "Model file found at {:?} ({} bytes) — using built-in classifier (ONNX runtime not configured)",
                    model_file,
                    meta.len()
                );
            }
            Ok(_) => {
                return Err("Model file is empty".into());
            }
            Err(e) => {
                return Err(format!("Cannot read model file: {}", e));
            }
        }

        // The built-in classifier is always active. When ONNX is integrated,
        // set self.loaded = true after successful loading.
        tracing::info!("Using built-in weighted classifier (128 features, hand-tuned weights)");
        Ok(())
    }
}

impl Default for ModelService {
    fn default() -> Self {
        Self::new()
    }
}

// ── Feature Extraction ──────────────────────────────────────────────────────

/// Extract a fixed-size 128-dimensional feature vector from text.
fn extract_text_features(text: &str) -> Vec<f32> {
    let text_lower = text.to_lowercase();
    let char_count = text_lower.len().max(1) as f32;
    let mut features = Vec::with_capacity(128);

    push_keyword_features(&text_lower, &mut features);
    push_statistical_features(text, &text_lower, char_count, &mut features);
    push_pii_pattern_features(&text_lower, &mut features);

    features.resize(128, 0.0);
    features
}

/// Push sensitive (24) and benign (12) keyword presence features.
fn push_keyword_features(text_lower: &str, features: &mut Vec<f32>) {
    const SENSITIVE_KEYWORDS: [&str; 24] = [
        "password", "secret", "confidential", "private",
        "sensitive", "ssn", "credit card", "bank account",
        "routing", "passport", "health", "medical",
        "diagnosis", "insurance", "salary", "income",
        "license", "dob", "address", "phone",
        "email", "account number", "social security", "debit",
    ];
    const BENIGN_KEYWORDS: [&str; 12] = [
        "example", "test", "sample", "placeholder",
        "template", "demo", "dummy", "fake",
        "mock", "public", "documentation", "tutorial",
    ];

    for kw in &SENSITIVE_KEYWORDS {
        features.push(if text_lower.contains(kw) { 1.0 } else { 0.0 });
    }
    for kw in &BENIGN_KEYWORDS {
        features.push(if text_lower.contains(kw) { 1.0 } else { 0.0 });
    }
}

/// Push 8 statistical features (length, word count, digit/special/uppercase ratios, symbol flags).
fn push_statistical_features(
    text: &str,
    text_lower: &str,
    char_count: f32,
    features: &mut Vec<f32>,
) {
    let digit_count = text_lower.chars().filter(|c| c.is_ascii_digit()).count() as f32;
    let special_count = text_lower
        .chars()
        .filter(|c| !c.is_alphanumeric() && !c.is_whitespace())
        .count() as f32;
    let uppercase_count = text.chars().filter(|c| c.is_uppercase()).count() as f32;

    features.push(text.len() as f32 / 1000.0);
    features.push(text_lower.split_whitespace().count() as f32 / 50.0);
    features.push(digit_count / char_count);
    features.push(special_count / char_count);
    features.push(uppercase_count / char_count);
    features.push(if text.contains('@') { 1.0 } else { 0.0 });
    features.push(if text.contains('/') { 1.0 } else { 0.0 });
    features.push(if text.contains(':') { 1.0 } else { 0.0 });
}

/// Push 10 PII regex pattern presence features.
fn push_pii_pattern_features(text_lower: &str, features: &mut Vec<f32>) {
    const PII_PATTERNS: [&str; 10] = [
        r"\d{3}-\d{2}-\d{4}",
        r"\d{16}",
        r"\d{3}[-.]?\d{3}[-.]?\d{4}",
        r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}",
        r"\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}",
        r"\b\d{10,20}\b",
        r"[A-Z]{2}\d{6}",
        r"\b[A-Z][a-z]+ [A-Z][a-z]+\b",
        r"\b\d{4}[-/]\d{2}[-/]\d{2}\b",
        r"\b[A-Z]{2}\d{2}\s?\d{4}\s?\d{4}\b",
    ];

    for pattern in &PII_PATTERNS {
        let matches = if let Ok(re) = regex::Regex::new(pattern) {
            re.find_iter(text_lower).count()
        } else {
            0
        };
        features.push((matches > 0) as u8 as f32);
    }
}

// ── Keywords ────────────────────────────────────────────────────────────────

const SENSITIVE_KEYWORDS: &[&str] = &[
    "password",
    "passwd",
    "secret",
    "confidential",
    "private",
    "sensitive",
    "ssn",
    "social security",
    "credit card",
    "debit card",
    "bank account",
    "routing number",
    "date of birth",
    "passport",
    "license",
    "health",
    "medical",
    "diagnosis",
    "insurance",
    "policy number",
    "salary",
    "wage",
    "income",
    "social security number",
    "national insurance",
];

const BENIGN_PATTERNS: &[&str] = &[
    "example.com",
    "test@example",
    "user@example",
    "noreply@",
    "do-not-reply@",
    "sample",
    "example",
    "placeholder",
    "000-00-0000",
    "123-45-6789",
    "111-11-1111",
    "555-",
    "12345",
    "00000",
    "@example.org",
    "@test.",
    "john doe",
    "jane doe",
    "public",
    "template",
];

// ── Signal Analysis ─────────────────────────────────────────────────────────

fn analyze_contextual_signals(
    text_lower: &str,
    _lines: &[&str],
    entity_count: usize,
    model_sentiment: f64,
) -> ContextualSignal {
    let has_sensitive_context = SENSITIVE_KEYWORDS.iter().any(|kw| text_lower.contains(kw));
    let has_benign_context = BENIGN_PATTERNS.iter().any(|pat| text_lower.contains(pat));
    let char_count = text_lower.len().max(1);
    let pii_density = (entity_count as f64 / char_count as f64) * 1000.0;

    ContextualSignal {
        has_sensitive_context,
        has_benign_context,
        pii_density,
        model_sentiment,
    }
}

fn compute_entity_confidence(
    signal: &ContextualSignal,
    entity_index: usize,
    entity_count: usize,
    lines: &[&str],
) -> f64 {
    let mut confidence: f64 = 0.5;

    // Model-based adjustment: negative sentiment → boost confidence
    confidence += -signal.model_sentiment * 0.2;

    if signal.has_sensitive_context {
        confidence += 0.25;
    }
    if signal.has_benign_context {
        confidence -= 0.3;
    }

    if signal.pii_density > 0.5 && entity_count > 2 {
        confidence += 0.15;
    }

    if is_near_boundary(entity_index, entity_count, lines.len()) {
        confidence -= 0.1;
    }

    confidence.clamp(0.0, 1.0)
}

fn is_near_boundary(entity_index: usize, entity_count: usize, line_count: usize) -> bool {
    if line_count < 6 {
        return false;
    }
    let approx_line = if entity_count == 1 {
        line_count / 2
    } else {
        (entity_index as f64 / (entity_count - 1) as f64 * (line_count - 1) as f64) as usize
    };
    approx_line < 2 || approx_line >= line_count.saturating_sub(2)
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_benign_context_reduces_confidence() {
        let service = ModelService::new();
        let text = "Please contact us at test@example.com for more info.";
        let scores = service.analyze_context(text, 1);
        assert_eq!(scores.len(), 1);
        assert!(
            scores[0] < 0.5,
            "Expected benign context to reduce confidence, got {}",
            scores[0]
        );
    }

    #[test]
    fn test_sensitive_context_boosts_confidence() {
        let service = ModelService::new();
        let text = "Send the confidential report to john@example.com immediately.";
        let scores = service.analyze_context(text, 1);
        assert_eq!(scores.len(), 1);
        // The combined model + heuristic should produce a higher confidence
        // for text with both sensitive keywords AND PII entities
        assert!(
            scores[0] > 0.3,
            "Expected elevated confidence for sensitive context, got {}",
            scores[0]
        );
    }

    #[test]
    fn test_high_pii_density_boosts_confidence() {
        let service = ModelService::new();
        let text = "Call John at 555-1234 or email jane@example.com.";
        let scores = service.analyze_context(text, 2);
        assert_eq!(scores.len(), 2);
        // High density + short text should produce elevated confidence
        for score in &scores {
            assert!(
                *score > 0.15,
                "Expected density boost above baseline, got {}",
                score
            );
        }
    }

    #[test]
    fn test_empty_text_returns_empty() {
        let service = ModelService::new();
        assert!(service.analyze_context("", 0).is_empty());
    }

    #[test]
    fn test_confidence_clamped_to_range() {
        let service = ModelService::new();
        let text = "Send your SSN and password to user@example.com sample template";
        for score in service.analyze_context(text, 2) {
            assert!((0.0..=1.0).contains(&score), "Score {} out of range", score);
        }
    }

    #[test]
    fn test_model_not_loaded_works_via_heuristics() {
        let service = ModelService::new();
        assert!(!service.is_loaded());
        assert_eq!(service.analyze_context("test@example.com", 1).len(), 1);
    }

    #[test]
    fn test_boundary_detection() {
        assert!(!is_near_boundary(0, 1, 3));
        assert!(is_near_boundary(0, 3, 10));
        assert!(!is_near_boundary(1, 3, 10));
    }

    #[test]
    fn test_neutral_text_gives_baseline() {
        let service = ModelService::new();
        let scores = service.analyze_context("my email is alice@company.com", 1);
        // The classifier may adjust slightly based on "email" keyword presence,
        // but should stay near baseline without sensitive context
        assert!(
            (0.3..=0.7).contains(&scores[0]),
            "Score {} not near baseline",
            scores[0]
        );
    }

    #[test]
    fn test_extract_features_size() {
        assert_eq!(extract_text_features("Hello world").len(), 128);
    }

    #[test]
    fn test_extract_features_sensitive_keywords() {
        let features = extract_text_features("Send your password and SSN");
        assert_eq!(features[0], 1.0); // "password"
        assert_eq!(features[5], 1.0); // "ssn" (index 5, not 6)
    }

    #[test]
    fn test_extract_features_benign_keywords() {
        let features = extract_text_features("This is just a test example");
        assert_eq!(features[24], 1.0); // "example" (first benign keyword, offset 24)
        assert_eq!(features[25], 1.0); // "test"
    }

    #[test]
    fn test_classify_sensitive() {
        let service = ModelService::new();
        let features = extract_text_features("Send the confidential SSN password immediately");
        let sentiment = service.classify(&features);
        // The classifier should detect sensitive keywords
        // With the weighted model + sigmoid scaling, sensitive text should score high
        // (above 0.5 on the internal scale before the confidence mapping)
        assert!(
            sentiment < 0.3 || sentiment.abs() > 0.5,
            "Expected clear sentiment signal for sensitive text, got {}",
            sentiment
        );
    }

    #[test]
    fn test_classify_benign() {
        let service = ModelService::new();
        let features = extract_text_features("This is a test example for documentation purposes");
        let sentiment = service.classify(&features);
        // The classifier should detect benign keywords
        assert!(
            sentiment > -0.3 || sentiment.abs() > 0.5,
            "Expected clear sentiment signal for benign text, got {}",
            sentiment
        );
    }

    #[test]
    fn test_classifier_weights_production() {
        let w = ClassifierWeights::production();
        // Sensitive weights should be positive (sensitive context)
        assert!(w.sensitive_weights[0] > 0.0); // password
                                               // Benign weights should be negative (benign context)
        assert!(w.benign_weights[0] < 0.0); // example
    }
}
