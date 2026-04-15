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

        // Deduplicate: if the same exact text appears multiple times,
        // reuse the same token
        let mut value_to_token: HashMap<String, String> = HashMap::new();
        let mut mappings: Vec<TokenMapping> = Vec::new();
        let mut replacements: Vec<(usize, usize, String)> = Vec::new();

        // Process matches in reverse order so position shifts don't affect later replacements
        let mut sorted_matches: Vec<&PiiMatch> = matches.iter().collect();
        sorted_matches.sort_by(|a, b| b.start.cmp(&a.start));

        for m in sorted_matches {
            // Check if we already created a token for this exact value
            if let Some(existing_token) = value_to_token.get(&m.text) {
                replacements.push((m.start, m.end, existing_token.clone()));
                continue;
            }

            // Create new token
            let type_key = m.pii_type.to_string();
            let counter = self.counters.entry(type_key.clone()).or_insert(0);
            *counter += 1;
            let token = format!("[{}_{}]", type_key, counter);

            value_to_token.insert(m.text.clone(), token.clone());

            mappings.push(TokenMapping {
                token: token.clone(),
                original: m.text.clone(),
                pii_type: m.pii_type.clone(),
                confidence: m.confidence,
            });

            replacements.push((m.start, m.end, token));
        }

        // Apply replacements (in reverse order, already sorted)
        let mut result = text.to_string();
        for (start, end, token) in replacements {
            if start <= result.len() && end <= result.len() {
                result.replace_range(start..end, &token);
            }
        }

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
        assert_eq!(result, "Email [Email_1] here");
        assert_eq!(mappings.len(), 1);
        assert_eq!(mappings[0].original, "john@acme.com");
        assert_eq!(mappings[0].token, "[Email_1]");
    }

    #[test]
    fn test_multiple_types() {
        let mut p = Pseudonymizer::new();
        let matches = vec![
            make_match(PiiType::Email, "john@acme.com", 0, 0.9),
            make_match(PiiType::IpAddress, "192.168.1.1", 17, 0.9),
        ];
        let (result, mappings) = p.pseudonymize("john@acme.com IP 192.168.1.1", &matches);
        assert_eq!(result, "[Email_1] IP [IP_Address_1]");
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
        assert_eq!(result, "[Email_1] and [Email_1]");
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
}
