use crate::pii::presidio::PresidioClient;
use crate::pii::recognizers::{self, PiiMatch, PiiType, Recognizer};
use once_cell::sync::Lazy;
use std::collections::HashMap;

/// Minimum confidence threshold for detection
const MIN_CONFIDENCE: f64 = 0.5;

static RECOGNIZERS: Lazy<Vec<Recognizer>> = Lazy::new(recognizers::all_recognizers);

/// The PII detection engine.
///
/// Detection strategy (layered):
///   1. **Presidio** (primary) — Microsoft Presidio via local microservice.
///      Best-in-class NLP-based detection with NER support.
///   2. **Custom recognizers** (safety layer) — Our own regex-based patterns.
///      Always run alongside Presidio to catch anything it misses.
///   3. **Denylist** (user-defined) — Custom patterns the user marks as always-flag.
///
/// Allowlist is applied last — matched entities on the allowlist are removed
/// regardless of which layer detected them.
#[derive(Clone)]
pub struct PiiEngine {
    /// Allowlist patterns — these are never flagged
    allow_patterns: Vec<regex::Regex>,
    /// Denylist patterns — these are always flagged (even if no recognizer matches)
    deny_patterns: Vec<regex::Regex>,
    /// Presidio client for NLP-based detection
    presidio: PresidioClient,
}

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
        }
    }

    /// Create an engine with a custom Presidio configuration.
    pub fn with_presidio(base_url: String, enabled: bool) -> Self {
        Self {
            allow_patterns: Vec::new(),
            deny_patterns: Vec::new(),
            presidio: PresidioClient::new(base_url, enabled),
        }
    }

    /// Add an allowlist regex pattern
    pub fn add_allow_pattern(&mut self, pattern: &str) -> Result<(), regex::Error> {
        self.allow_patterns.push(regex::Regex::new(pattern)?);
        Ok(())
    }

    /// Add a denylist regex pattern
    pub fn add_deny_pattern(&mut self, pattern: &str) -> Result<(), regex::Error> {
        self.deny_patterns.push(regex::Regex::new(pattern)?);
        Ok(())
    }

    /// Check if the Presidio service is enabled
    pub fn presidio_enabled(&self) -> bool {
        self.presidio.is_enabled()
    }

    /// Enable or disable the Presidio service
    pub fn set_presidio_enabled(&mut self, enabled: bool) {
        self.presidio.set_enabled(enabled);
    }

    /// Update the Presidio service URL
    pub fn set_presidio_url(&mut self, url: String) {
        self.presidio.set_url(url);
    }

    /// Get a reference to the Presidio client (for health checks etc.)
    pub fn presidio_client(&self) -> &PresidioClient {
        &self.presidio
    }

    /// Run our custom recognizers (the safety layer).
    /// Always runs regardless of Presidio status.
    fn detect_custom(&self, text: &str) -> Vec<PiiMatch> {
        let mut matches = self.detect_with_recognizers(text);
        self.detect_with_denylist(text, &mut matches);
        matches
    }

    /// Run all built-in recognizers against the text.
    fn detect_with_recognizers(&self, text: &str) -> Vec<PiiMatch> {
        let mut matches = Vec::new();

        for recognizer in RECOGNIZERS.iter() {
            if recognizer.confidence < MIN_CONFIDENCE {
                continue;
            }

            for mat in recognizer.regex.find_iter(text) {
                let matched_text = mat.as_str();
                if self.is_allowed(matched_text) {
                    continue;
                }
                if let Some(validator) = recognizer.validator {
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

    /// Check denylist patterns and append any non-duplicate matches.
    fn detect_with_denylist(&self, text: &str, matches: &mut Vec<PiiMatch>) {
        for pattern in &self.deny_patterns {
            for mat in pattern.find_iter(text) {
                let matched_text = mat.as_str();
                if self.is_allowed(matched_text) {
                    continue;
                }
                if matches.iter().any(|m| m.start == mat.start() && m.end == mat.end()) {
                    continue;
                }

                matches.push(PiiMatch {
                    pii_type: PiiType::ApiKey,
                    text: matched_text.to_string(),
                    start: mat.start(),
                    end: mat.end(),
                    confidence: 0.95,
                });
            }
        }
    }

    /// Scan text for PII entities and return all matches above the confidence threshold.
    ///
    /// **Detection is layered:**
    /// 1. If Presidio is available, its results are collected first.
    /// 2. Our custom recognizers always run as a safety net.
    /// 3. Results are merged, duplicates resolved, and allowlist applied.
    /// 4. If Presidio is down, custom recognizers provide full coverage.
    pub async fn detect(&self, text: &str) -> Vec<PiiMatch> {
        let mut matches: Vec<PiiMatch> = Vec::new();

        // Layer 1: Presidio (primary NLP-based detection)
        if let Some(presidio_matches) = self.presidio.analyze(text, MIN_CONFIDENCE).await {
            // Apply allowlist to Presidio results
            for m in presidio_matches {
                if !self.is_allowed(&m.text) {
                    matches.push(m);
                }
            }
        }

        // Layer 2: Custom recognizers (safety layer — always runs)
        let custom_matches = self.detect_custom(text);
        for m in custom_matches {
            if !self.is_allowed(&m.text) {
                matches.push(m);
            }
        }

        // Layer 3: Resolve overlapping matches — keep highest confidence
        resolve_overlaps(&mut matches);

        matches
    }

    /// Synchronous version of `detect` — for use in non-async contexts
    /// (e.g. clipboard monitor polling). Uses `block_in_place`.
    pub fn detect_sync(&self, text: &str) -> Vec<PiiMatch> {
        let engine = self.clone();
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(engine.detect(text))
        })
    }

    /// Quick check if text contains any PII
    pub async fn contains_pii(&self, text: &str) -> bool {
        !self.detect(text).await.is_empty()
    }

    fn is_allowed(&self, text: &str) -> bool {
        self.allow_patterns.iter().any(|re| re.is_match(text))
    }
}

/// Resolve overlapping matches — when two matches cover the same text region,
/// keep the one with higher confidence and discard the other.
fn resolve_overlaps(matches: &mut Vec<PiiMatch>) {
    matches.sort_by(|a, b| {
        a.start
            .cmp(&b.start)
            .then_with(|| {
                b.confidence
                    .partial_cmp(&a.confidence)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    let mut result = Vec::new();
    let mut last_end = 0;
    for m in matches.iter() {
        if m.start >= last_end {
            result.push(m.clone());
            last_end = m.end;
        }
        // If overlapping, skip (the earlier higher-confidence match was already kept)
    }
    *matches = result;
}

/// Build a summary of detected entities by type
pub fn summarize_matches(matches: &[PiiMatch]) -> HashMap<String, usize> {
    let mut summary = HashMap::new();
    for m in matches {
        *summary.entry(m.pii_type.to_string()).or_insert(0) += 1;
    }
    summary
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_detect_email_in_text() {
        let engine = PiiEngine::with_presidio("http://localhost:9999".into(), false);
        let matches = engine.detect("Send it to alice@example.com please").await;
        assert!(!matches.is_empty());
        assert!(matches.iter().any(|m| m.pii_type == PiiType::Email));
    }

    #[tokio::test]
    async fn test_detect_multiple_types() {
        let engine = PiiEngine::with_presidio("http://localhost:9999".into(), false);
        let text = "Contact john@test.com or call 555-123-4567, server is 10.0.0.1";
        let matches = engine.detect(text).await;
        let types: Vec<&PiiType> = matches.iter().map(|m| &m.pii_type).collect();
        assert!(types.contains(&&PiiType::Email));
        assert!(types.contains(&&PiiType::PhoneNumber));
        assert!(types.contains(&&PiiType::IpAddress));
    }

    #[tokio::test]
    async fn test_allowlist_skips_match() {
        let mut engine = PiiEngine::with_presidio("http://localhost:9999".into(), false);
        engine.add_allow_pattern(r"example\.com").unwrap();
        let matches = engine.detect("Contact alice@example.com").await;
        assert!(!matches.iter().any(|m| m.pii_type == PiiType::Email));
    }

    #[tokio::test]
    async fn test_denylist_catches_custom() {
        let mut engine = PiiEngine::with_presidio("http://localhost:9999".into(), false);
        engine.add_deny_pattern(r"PROJECT_ALPHA_\w+").unwrap();
        let matches = engine.detect("The code is PROJECT_ALPHA_SECRET").await;
        assert!(matches.iter().any(|m| m.text == "PROJECT_ALPHA_SECRET"));
    }

    #[tokio::test]
    async fn test_no_false_positive_ip_in_code() {
        let engine = PiiEngine::with_presidio("http://localhost:9999".into(), false);
        // Version numbers should not match IP regex
        let matches = engine.detect("version 1.0.0 released").await;
        assert!(!matches.iter().any(|m| m.pii_type == PiiType::IpAddress));
    }

    #[tokio::test]
    async fn test_summarize() {
        let engine = PiiEngine::with_presidio("http://localhost:9999".into(), false);
        let matches = engine.detect("a@b.com and c@d.com and 192.168.1.1").await;
        let summary = summarize_matches(&matches);
        assert_eq!(*summary.get("Email").unwrap(), 2);
        assert_eq!(*summary.get("IP_Address").unwrap(), 1);
    }

    #[tokio::test]
    async fn test_presidio_disabled_skips_gracefully() {
        let engine = PiiEngine::with_presidio("http://localhost:9999".into(), false);
        // Should still work with custom recognizers
        let matches = engine.detect("john@test.com").await;
        assert!(matches.iter().any(|m| m.pii_type == PiiType::Email));
    }

    #[tokio::test]
    async fn test_presidio_unreachable_falls_back() {
        let engine = PiiEngine::with_presidio("http://localhost:19999".into(), true);
        // Should fall back to custom recognizers when Presidio is unreachable
        let matches = engine.detect("john@test.com").await;
        assert!(matches.iter().any(|m| m.pii_type == PiiType::Email));
    }

    #[test]
    fn test_ner_types_in_summarize() {
        // Verify that Person, Location, Organization PiiTypes are included
        // in summarize_matches output when present.
        let matches = vec![
            PiiMatch {
                pii_type: PiiType::Person,
                text: "John Smith".into(),
                start: 0,
                end: 10,
                confidence: 0.85,
            },
            PiiMatch {
                pii_type: PiiType::Location,
                text: "New York".into(),
                start: 15,
                end: 23,
                confidence: 0.80,
            },
            PiiMatch {
                pii_type: PiiType::Organization,
                text: "Acme Corp".into(),
                start: 28,
                end: 37,
                confidence: 0.75,
            },
        ];
        let summary = summarize_matches(&matches);
        assert_eq!(summary.get("Person"), Some(&1));
        assert_eq!(summary.get("Location"), Some(&1));
        assert_eq!(summary.get("Organization"), Some(&1));
    }
}
