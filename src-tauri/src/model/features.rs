// ── Feature Extraction Constants ──

/// Dimensionality of the fixed-size feature vector
const FEATURE_VECTOR_DIM: usize = 128;

/// Scaling factor for normalizing text length into a feature
const TEXT_LENGTH_SCALE: f32 = 1000.0;

/// Scaling factor for normalizing word count into a feature
const WORD_COUNT_SCALE: f32 = 50.0;

// ── Confidence Tuning Constants ──

/// Base confidence score before contextual adjustments
const CONFIDENCE_BASE: f64 = 0.5;

/// Confidence boost when model sentiment indicates sensitive content (multiplier for -sentiment)
const CONFIDENCE_SENTIMENT_BOOST: f64 = 0.2;

/// Confidence boost when sensitive context keywords are present
const CONFIDENCE_SENSITIVE_CONTEXT_BOOST: f64 = 0.25;

/// Confidence penalty when benign/test patterns are detected
const CONFIDENCE_BENIGN_CONTEXT_PENALTY: f64 = 0.3;

/// Confidence boost when PII density is high and entity count exceeds threshold
const CONFIDENCE_HIGH_DENSITY_BOOST: f64 = 0.15;

/// PII density threshold for triggering the high-density confidence boost
const PII_DENSITY_THRESHOLD: f64 = 0.5;

/// Minimum entity count to trigger the high-density confidence boost
const HIGH_DENSITY_MIN_ENTITIES: usize = 2;

/// Confidence penalty when an entity is near a text boundary
const CONFIDENCE_BOUNDARY_PENALTY: f64 = 0.1;

/// Minimum line count to consider boundary detection
const BOUNDARY_MIN_LINES: usize = 6;

/// Lines from the edge considered "near boundary"
const BOUNDARY_EDGE_LINES: usize = 2;

/// Scaling factor for normalizing PII density to per-1000-chars
const PII_DENSITY_SCALE: f64 = 1000.0;

// ── Feature Groups ──

/// Sensitive keyword presence (24 features)
const SENSITIVE_KEYWORDS_24: [&str; 24] = [
    "password",
    "secret",
    "confidential",
    "private",
    "sensitive",
    "ssn",
    "credit card",
    "bank account",
    "routing",
    "passport",
    "health",
    "medical",
    "diagnosis",
    "insurance",
    "salary",
    "income",
    "license",
    "dob",
    "address",
    "phone",
    "email",
    "account number",
    "social security",
    "debit",
];

/// Benign keyword presence (12 features)
const BENIGN_KEYWORDS_12: [&str; 12] = [
    "example",
    "test",
    "sample",
    "placeholder",
    "template",
    "demo",
    "dummy",
    "fake",
    "mock",
    "public",
    "documentation",
    "tutorial",
];

/// PII regex patterns (10 features)
const PII_PATTERNS_10: [&str; 10] = [
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

/// Contextual sensitivity signals derived from surrounding text.
#[derive(Debug, Clone, Copy)]
pub struct ContextualSignal {
    pub has_sensitive_context: bool,
    pub has_benign_context: bool,
    pub pii_density: f64,
    pub model_sentiment: f64,
}

/// Keywords that indicate sensitive content
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

/// Patterns that indicate benign/test content
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

// ── Feature Extraction ──

/// Extract a fixed-size feature vector from text.
pub fn extract_text_features(text: &str) -> Vec<f32> {
    let text_lower = text.to_lowercase();
    let char_count = text_lower.len().max(1) as f32;
    let mut features = Vec::with_capacity(FEATURE_VECTOR_DIM);

    extract_sensitive_keywords(&text_lower, &mut features);
    extract_benign_keywords(&text_lower, &mut features);
    extract_statistical_features(text, &text_lower, char_count, &mut features);
    extract_pii_patterns(&text_lower, &mut features);

    // Pad to target dimensionality
    features.resize(FEATURE_VECTOR_DIM, 0.0);
    features
}

fn extract_sensitive_keywords(text: &str, features: &mut Vec<f32>) {
    for kw in SENSITIVE_KEYWORDS_24 {
        features.push(if text.contains(kw) { 1.0 } else { 0.0 });
    }
}

fn extract_benign_keywords(text: &str, features: &mut Vec<f32>) {
    for kw in BENIGN_KEYWORDS_12 {
        features.push(if text.contains(kw) { 1.0 } else { 0.0 });
    }
}

fn extract_statistical_features(
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

    features.push(text.len() as f32 / TEXT_LENGTH_SCALE);
    features.push(text_lower.split_whitespace().count() as f32 / WORD_COUNT_SCALE);
    features.push(digit_count / char_count);
    features.push(special_count / char_count);
    features.push(uppercase_count / char_count);
    features.push(if text.contains('@') { 1.0 } else { 0.0 });
    features.push(if text.contains('/') { 1.0 } else { 0.0 });
    features.push(if text.contains(':') { 1.0 } else { 0.0 });
}

fn extract_pii_patterns(text: &str, features: &mut Vec<f32>) {
    for pattern in PII_PATTERNS_10 {
        let matches = match regex::Regex::new(pattern) {
            Ok(re) => re.find_iter(text).count(),
            Err(_) => 0,
        };
        features.push((matches > 0) as u8 as f32);
    }
}

// ── Signal Analysis ──

/// Analyze contextual signals in text to determine sensitivity.
pub fn analyze_contextual_signals(
    text_lower: &str,
    _lines: &[&str],
    entity_count: usize,
    model_sentiment: f64,
) -> ContextualSignal {
    let has_sensitive_context = SENSITIVE_KEYWORDS.iter().any(|kw| text_lower.contains(kw));
    let has_benign_context = BENIGN_PATTERNS.iter().any(|pat| text_lower.contains(pat));
    let char_count = text_lower.len().max(1);
    let pii_density = (entity_count as f64 / char_count as f64) * PII_DENSITY_SCALE;

    ContextualSignal {
        has_sensitive_context,
        has_benign_context,
        pii_density,
        model_sentiment,
    }
}

/// Compute confidence score for an entity based on contextual signals.
pub fn compute_entity_confidence(
    signal: &ContextualSignal,
    entity_index: usize,
    entity_count: usize,
    lines: &[&str],
) -> f64 {
    let mut confidence: f64 = CONFIDENCE_BASE;

    // Model-based adjustment: negative sentiment → boost confidence
    confidence += -signal.model_sentiment * CONFIDENCE_SENTIMENT_BOOST;

    if signal.has_sensitive_context {
        confidence += CONFIDENCE_SENSITIVE_CONTEXT_BOOST;
    }
    if signal.has_benign_context {
        confidence -= CONFIDENCE_BENIGN_CONTEXT_PENALTY;
    }

    if signal.pii_density > PII_DENSITY_THRESHOLD && entity_count > HIGH_DENSITY_MIN_ENTITIES {
        confidence += CONFIDENCE_HIGH_DENSITY_BOOST;
    }

    if is_near_boundary(entity_index, entity_count, lines.len()) {
        confidence -= CONFIDENCE_BOUNDARY_PENALTY;
    }

    confidence.clamp(0.0, 1.0)
}

/// Check if an entity is near the boundary of a text block.
pub fn is_near_boundary(entity_index: usize, entity_count: usize, line_count: usize) -> bool {
    if line_count < BOUNDARY_MIN_LINES {
        return false;
    }
    let approx_line = if entity_count == 1 {
        line_count / 2
    } else {
        (entity_index as f64 / (entity_count - 1) as f64 * (line_count - 1) as f64) as usize
    };
    approx_line < BOUNDARY_EDGE_LINES || approx_line >= line_count.saturating_sub(BOUNDARY_EDGE_LINES)
}
