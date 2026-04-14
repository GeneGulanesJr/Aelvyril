use crate::pii::recognizers::{self, PiiMatch, PiiType, Recognizer};
use once_cell::sync::Lazy;
use std::collections::HashMap;

/// Minimum confidence threshold for detection
const MIN_CONFIDENCE: f64 = 0.5;

static RECOGNIZERS: Lazy<Vec<Recognizer>> = Lazy::new(recognizers::all_recognizers);

/// The PII detection engine
pub struct PiiEngine {
    /// Allowlist patterns — these are never flagged
    allow_patterns: Vec<regex::Regex>,
    /// Denylist patterns — these are always flagged (even if no recognizer matches)
    deny_patterns: Vec<regex::Regex>,
}

impl PiiEngine {
    pub fn new() -> Self {
        Self {
            allow_patterns: Vec::new(),
            deny_patterns: Vec::new(),
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

    /// Scan text for PII entities and return all matches above the confidence threshold
    pub fn detect(&self, text: &str) -> Vec<PiiMatch> {
        let mut matches: Vec<PiiMatch> = Vec::new();

        // Run all recognizers
        for recognizer in RECOGNIZERS.iter() {
            if recognizer.confidence < MIN_CONFIDENCE {
                continue;
            }

            for mat in recognizer.regex.find_iter(text) {
                let matched_text = mat.as_str();

                // Skip if in allowlist
                if self.is_allowed(matched_text) {
                    continue;
                }

                // Validate if the recognizer has a validator
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

        // Check denylist patterns
        for pattern in &self.deny_patterns {
            for mat in pattern.find_iter(text) {
                let matched_text = mat.as_str();
                if self.is_allowed(matched_text) {
                    continue;
                }

                // Don't add duplicates
                if matches.iter().any(|m| m.start == mat.start() && m.end == mat.end()) {
                    continue;
                }

                matches.push(PiiMatch {
                    pii_type: PiiType::ApiKey, // Default denylist type
                    text: matched_text.to_string(),
                    start: mat.start(),
                    end: mat.end(),
                    confidence: 0.95,
                });
            }
        }

        // Resolve overlapping matches — keep highest confidence
        resolve_overlaps(&mut matches);

        matches
    }

    /// Quick check if text contains any PII
    pub fn contains_pii(&self, text: &str) -> bool {
        !self.detect(text).is_empty()
    }

    fn is_allowed(&self, text: &str) -> bool {
        self.allow_patterns.iter().any(|re| re.is_match(text))
    }
}

/// Resolve overlapping matches by keeping the highest-confidence match
fn resolve_overlaps(matches: &mut Vec<PiiMatch>) {
    matches.sort_by(|a, b| {
        a.start.cmp(&b.start).then_with(|| b.confidence.partial_cmp(&a.confidence).unwrap())
    });

    let mut resolved: Vec<PiiMatch> = Vec::new();
    for m in matches.drain(..) {
        let overlaps = resolved.iter().any(|existing| {
            m.start < existing.end && m.end > existing.start
        });

        if !overlaps {
            resolved.push(m);
        } else if let Some(existing) = resolved.iter_mut().find(|existing| {
            m.start < existing.end && m.end > existing.start && m.confidence > existing.confidence
        }) {
            *existing = m;
        }
    }

    *matches = resolved;
    matches.sort_by_key(|m| m.start);
}

/// Build a summary of detected entities by type
pub fn summarize_matches(matches: &[PiiMatch]) -> HashMap<String, usize> {
    let mut summary: HashMap<String, usize> = HashMap::new();
    for m in matches {
        *summary.entry(m.pii_type.to_string()).or_insert(0) += 1;
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_email_in_text() {
        let engine = PiiEngine::new();
        let matches = engine.detect("Send it to alice@example.com please");
        assert!(!matches.is_empty());
        assert!(matches.iter().any(|m| m.pii_type == PiiType::Email));
    }

    #[test]
    fn test_detect_multiple_types() {
        let engine = PiiEngine::new();
        let text = "Contact john@test.com or call 555-123-4567, server is 10.0.0.1";
        let matches = engine.detect(text);
        let types: Vec<&PiiType> = matches.iter().map(|m| &m.pii_type).collect();
        assert!(types.contains(&&PiiType::Email));
        assert!(types.contains(&&PiiType::PhoneNumber));
        assert!(types.contains(&&PiiType::IpAddress));
    }

    #[test]
    fn test_allowlist_skips_match() {
        let mut engine = PiiEngine::new();
        engine.add_allow_pattern(r"example\.com").unwrap();
        let matches = engine.detect("Contact alice@example.com");
        assert!(!matches.iter().any(|m| m.pii_type == PiiType::Email));
    }

    #[test]
    fn test_denylist_catches_custom() {
        let mut engine = PiiEngine::new();
        engine.add_deny_pattern(r"PROJECT_ALPHA_\w+").unwrap();
        let matches = engine.detect("The code is PROJECT_ALPHA_SECRET");
        assert!(matches.iter().any(|m| m.text == "PROJECT_ALPHA_SECRET"));
    }

    #[test]
    fn test_no_false_positive_ip_in_code() {
        let engine = PiiEngine::new();
        // Version numbers should not match IP regex
        let matches = engine.detect("version 1.0.0 released");
        assert!(!matches.iter().any(|m| m.pii_type == PiiType::IpAddress));
    }

    #[test]
    fn test_summarize() {
        let engine = PiiEngine::new();
        let matches = engine.detect("a@b.com and c@d.com and 192.168.1.1");
        let summary = summarize_matches(&matches);
        assert_eq!(*summary.get("Email").unwrap(), 2);
        assert_eq!(*summary.get("IP_Address").unwrap(), 1);
    }
}
