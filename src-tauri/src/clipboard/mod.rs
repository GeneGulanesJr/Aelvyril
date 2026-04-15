pub mod monitor;

use serde::{Deserialize, Serialize};

/// A clipboard event with detected PII
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardEvent {
    pub id: String,
    pub timestamp: String,
    pub content_length: usize,
    pub detected_entities: Vec<(String, usize)>,
    pub action_taken: ClipboardAction,
}

/// What was done about the detected PII
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ClipboardAction {
    /// No PII detected — passed through
    Clean,
    /// PII detected, user chose to sanitize
    Sanitized,
    /// PII detected, user chose to allow anyway
    Allowed,
    /// PII detected, user blocked the paste
    Blocked,
    /// Still pending user action
    Pending,
}

/// User's response to a clipboard notification
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ClipboardResponse {
    Sanitize,
    Allow,
    Block,
}
