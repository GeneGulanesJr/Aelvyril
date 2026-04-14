use crate::pii::recognizers::PiiType;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// A single token-to-original mapping
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenMapping {
    pub token: String,
    pub original: String,
    pub pii_type: PiiType,
    pub confidence: f64,
}

/// Session-level mapping table with TTL
#[derive(Debug)]
pub struct MappingTable {
    /// Token → original value
    pub mappings: HashMap<String, TokenMapping>,
    /// When each token was last accessed
    pub last_accessed: HashMap<String, Instant>,
    /// TTL for mappings
    pub ttl: Duration,
}

impl MappingTable {
    pub fn new(ttl: Duration) -> Self {
        Self {
            mappings: HashMap::new(),
            last_accessed: HashMap::new(),
            ttl,
        }
    }

    /// Create with default 30-minute TTL
    pub fn with_default_ttl() -> Self {
        Self::new(Duration::from_secs(30 * 60))
    }

    /// Add mappings from pseudonymization
    pub fn add_mappings(&mut self, new_mappings: Vec<TokenMapping>) {
        let now = Instant::now();
        for mapping in new_mappings {
            self.last_accessed.insert(mapping.token.clone(), now);
            self.mappings.insert(mapping.token.clone(), mapping);
        }
    }

    /// Look up the original value for a token
    pub fn lookup(&mut self, token: &str) -> Option<&TokenMapping> {
        if let Some(accessed) = self.last_accessed.get_mut(token) {
            *accessed = Instant::now();
        }
        self.mappings.get(token)
    }

    /// Get all mappings (for batch rehydration)
    pub fn all_mappings(&self) -> &HashMap<String, TokenMapping> {
        &self.mappings
    }

    /// Expire stale mappings past TTL
    pub fn expire(&mut self) {
        let now = Instant::now();
        let expired: Vec<String> = self
            .last_accessed
            .iter()
            .filter(|(_, &last)| now.duration_since(last) > self.ttl)
            .map(|(token, _)| token.clone())
            .collect();

        for token in expired {
            self.mappings.remove(&token);
            self.last_accessed.remove(&token);
        }
    }

    /// Clear all mappings
    pub fn clear(&mut self) {
        self.mappings.clear();
        self.last_accessed.clear();
    }

    /// Number of active mappings
    pub fn len(&self) -> usize {
        self.mappings.len()
    }

    pub fn is_empty(&self) -> bool {
        self.mappings.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add_and_lookup() {
        let mut table = MappingTable::with_default_ttl();
        table.add_mappings(vec![TokenMapping {
            token: "[Email_1]".into(),
            original: "john@acme.com".into(),
            pii_type: PiiType::Email,
            confidence: 0.9,
        }]);

        let mapping = table.lookup("[Email_1]").unwrap();
        assert_eq!(mapping.original, "john@acme.com");
    }

    #[test]
    fn test_lookup_nonexistent() {
        let mut table = MappingTable::with_default_ttl();
        assert!(table.lookup("[Email_99]").is_none());
    }

    #[test]
    fn test_expire() {
        let mut table = MappingTable::new(Duration::from_millis(10));
        table.add_mappings(vec![TokenMapping {
            token: "[Email_1]".into(),
            original: "test@test.com".into(),
            pii_type: PiiType::Email,
            confidence: 0.9,
        }]);

        std::thread::sleep(Duration::from_millis(20));
        table.expire();
        assert!(table.lookup("[Email_1]").is_none());
    }

    #[test]
    fn test_clear() {
        let mut table = MappingTable::with_default_ttl();
        table.add_mappings(vec![TokenMapping {
            token: "[Email_1]".into(),
            original: "test@test.com".into(),
            pii_type: PiiType::Email,
            confidence: 0.9,
        }]);
        table.clear();
        assert!(table.is_empty());
    }
}
