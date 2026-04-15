pub mod store;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// A single audit log entry — never stores raw PII values
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: String,
    pub timestamp: DateTime<Utc>,
    pub session_id: String,
    pub provider: String,
    pub model: String,
    /// (entity_type, count) — e.g. [("Email", 2), ("Phone", 1)]
    pub entity_types: Vec<(String, usize)>,
    pub total_entities: usize,
    pub streaming: bool,
    /// Tokens that were generated, e.g. ["Email_1", "Phone_1"]
    pub tokens_generated: Vec<String>,
}
