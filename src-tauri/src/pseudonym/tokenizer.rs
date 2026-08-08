use crate::pii::recognizers::PiiMatch;
use crate::pseudonym::mapping::TokenMapping;
use std::collections::HashMap;

/// Replaces detected PII entities with typed, numbered tokens
pub struct Pseudonymizer {
    /// Tracks per-type counters for token numbering
    counters: HashMap<String, usize>,
}

impl Default for Pseudonymizer {
    fn default() -> Self {
        Self::new()
    }
}

impl Pseudonymizer {
    pub fn new() -> Self {
        Self {
            counters: HashMap::new(),
        }
    }

    fn next_token(&mut self, pii_type: &crate::pii::recognizers::PiiType) -> String {
        let type_key = pii_type.to_string();
        let counter = self.counters.entry(type_key.clone()).or_insert(0);
        *counter += 1;
        format!("[{}_{}]", type_key, counter)
    }

    fn build_replacements_and_mappings(
        &mut self,
        matches: &[PiiMatch],
    ) -> (Vec<(usize, usize, String)>, Vec<TokenMapping>) {
        // Deduplicate: if the same exact text appears multiple times, reuse the same token.
        let mut value_to_token: HashMap<String, String> = HashMap::new();
        let mut mappings: Vec<TokenMapping> = Vec::new();
        let mut replacements: Vec<(usize, usize, String)> = Vec::new();

        // Process matches in reverse order so position shifts don't affect later replacements.
        let mut sorted_matches: Vec<&PiiMatch> = matches.iter().collect();
        sorted_matches.sort_by(|a, b| b.start.cmp(&a.start));

        for m in sorted_matches {
            if let Some(existing_token) = value_to_token.get(&m.text) {
                replacements.push((m.start, m.end, existing_token.clone()));
                continue;
            }

            let token = self.next_token(&m.pii_type);
            value_to_token.insert(m.text.clone(), token.clone());

            mappings.push(TokenMapping {
                token: token.clone(),
                original: m.text.clone(),
                pii_type: m.pii_type.clone(),
                confidence: m.confidence,
            });

            replacements.push((m.start, m.end, token));
        }

        (replacements, mappings)
    }

    fn apply_replacements(text: &str, replacements: Vec<(usize, usize, String)>) -> String {
        let mut result = text.to_string();
        for (start, end, token) in replacements {
            // Char-boundary-safe replacement: `replace_range` panics (like
            // direct slicing) if `start..end` is not on a UTF-8 char
            // boundary. PII spans are byte offsets that may split a
            // multibyte char in non-ASCII input; such a misaligned span
            // must be skipped (the token is still emitted via the mapping)
            // rather than panic the worker. ASCII spans are unaffected.
            if crate::pii::safe_slice(&result, start, end).is_none() {
                tracing::debug!(
                    start,
                    end,
                    "Pseudonymize replacement span on a non-char boundary, skipping"
                );
                continue;
            }
            result.replace_range(start..end, &token);
        }
        result
    }

    /// Replace all PII matches with tokens, returning the pseudonymized text
    /// and a mapping of tokens to original values.
    ///
    /// Example:
    ///   Input:  "Email john@acme.com and IP 192.168.1.1"
    ///   Output: "Email [Email_1] and IP [IP_Address_1]"
    pub fn pseudonymize(
        &mut self,
        text: &str,
        matches: &[PiiMatch],
    ) -> (String, Vec<TokenMapping>) {
        if matches.is_empty() {
            return (text.to_string(), Vec::new());
        }
        let (replacements, mappings) = self.build_replacements_and_mappings(matches);
        let result = Self::apply_replacements(text, replacements);
        (result, mappings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pii::recognizers::PiiType;

    fn make_match(pii_type: PiiType, text: &str, start: usize, confidence: f64) -> PiiMatch {
        PiiMatch {
            pii_type,
            text: text.to_string(),
            start,
            end: start + text.len(),
            confidence,
        }
    }

    #[test]
    fn test_basic_pseudonymization() {
        let mut p = Pseudonymizer::new();
        let matches = vec![make_match(PiiType::Email, "john@acme.com", 6, 0.9)];
        let (result, mappings) = p.pseudonymize("Email john@acme.com here", &matches);
        assert_eq!(result, "Email [EMAIL_ADDRESS_1] here");
        assert_eq!(mappings.len(), 1);
        assert_eq!(mappings[0].original, "john@acme.com");
        assert_eq!(mappings[0].token, "[EMAIL_ADDRESS_1]");
    }

    #[test]
    fn test_multiple_types() {
        let mut p = Pseudonymizer::new();
        let matches = vec![
            make_match(PiiType::Email, "john@acme.com", 0, 0.9),
            make_match(PiiType::IpAddress, "192.168.1.1", 17, 0.9),
        ];
        let (result, mappings) = p.pseudonymize("john@acme.com IP 192.168.1.1", &matches);
        assert_eq!(result, "[EMAIL_ADDRESS_1] IP [IP_ADDRESS_1]");
        assert_eq!(mappings.len(), 2);
    }

    #[test]
    fn test_deduplication_same_value() {
        let mut p = Pseudonymizer::new();
        let text = "john@acme.com and john@acme.com";
        let matches = vec![
            make_match(PiiType::Email, "john@acme.com", 0, 0.9),
            make_match(PiiType::Email, "john@acme.com", 18, 0.9),
        ];
        let (result, mappings) = p.pseudonymize(text, &matches);
        assert_eq!(result, "[EMAIL_ADDRESS_1] and [EMAIL_ADDRESS_1]");
        assert_eq!(mappings.len(), 1); // Only one mapping — deduped
    }

    #[test]
    fn test_no_matches() {
        let mut p = Pseudonymizer::new();
        let text = "No PII here";
        let (result, mappings) = p.pseudonymize(text, &[]);
        assert_eq!(result, text);
        assert!(mappings.is_empty());
    }

    // Regression: a PII span whose byte range splits a multibyte UTF-8 char
    // must NOT panic the worker. The token is still emitted (via the mapping)
    // but the misaligned replacement is skipped, leaving the original text
    // intact at that location. ASCII inputs are unaffected.
    #[test]
    fn test_pseudonymize_multibyte_misaligned_span_does_not_panic() {
        let mut p = Pseudonymizer::new();
        // "Héllo" — 'é' is bytes 1..3. A span [1..2] splits the 'é'.
        let text = "Héllo world";
        // Fabricate a match with a span that starts inside 'é': byte 1..2.
        let bad_match = PiiMatch {
            pii_type: PiiType::Email,
            text: "\u{00e9}".to_string(), // the 'é' — distinct text for dedup
            start: 1,
            end: 2,
            confidence: 0.9,
        };
        // Must not panic.
        let (result, mappings) = p.pseudonymize(text, &[bad_match]);
        // Misaligned span is skipped — original text unchanged.
        assert_eq!(result, text, "misaligned span must be skipped, text unchanged");
        // The mapping is still recorded (token emitted) even though the text
        // body was left intact — no silent data loss.
        assert_eq!(mappings.len(), 1, "token mapping still emitted for skipped span");
    }
}
