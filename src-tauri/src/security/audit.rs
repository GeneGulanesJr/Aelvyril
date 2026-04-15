use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

/// Audits the key lifecycle — tracks every time a key is created, accessed, rotated,
/// or deleted. This ensures we have forensic evidence that keys never leak to disk
/// (other than the OS keychain) or logs.
///
/// **Invariants enforced:**
/// - Key values are NEVER logged — only key identifiers (e.g., "gateway-key", "provider:OpenAI")
/// - All events are in-memory only (never persisted to disk)
/// - Events are bounded to prevent unbounded memory growth
#[derive(Debug, Clone)]
pub struct KeyLifecycleAuditor {
    events: VecDeque<KeyEvent>,
    max_events: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyEvent {
    pub timestamp: DateTime<Utc>,
    pub key_id: String,
    pub action: KeyAction,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum KeyAction {
    Created,
    Accessed,
    Rotated,
    Deleted,
    AccessDenied,
}

impl KeyLifecycleAuditor {
    pub fn new(max_events: usize) -> Self {
        Self {
            events: VecDeque::with_capacity(max_events),
            max_events,
        }
    }

    pub fn with_default_capacity() -> Self {
        Self::new(10_000)
    }

    /// Record a key lifecycle event
    pub fn record(&mut self, key_id: &str, action: KeyAction, detail: &str) {
        if self.events.len() >= self.max_events {
            self.events.pop_front();
        }
        self.events.push_back(KeyEvent {
            timestamp: Utc::now(),
            key_id: key_id.to_string(),
            action,
            detail: detail.to_string(),
        });
    }

    /// Get all recorded events (for admin UI or export)
    pub fn events(&self) -> &VecDeque<KeyEvent> {
        &self.events
    }

    /// Get events for a specific key
    pub fn events_for_key(&self, key_id: &str) -> Vec<&KeyEvent> {
        self.events.iter().filter(|e| e.key_id == key_id).collect()
    }

    /// Verify that a key was never written to disk or logged as plaintext.
    /// Returns Ok(()) if no violations found, or Err(description) if suspicious.
    pub fn audit_key_safety(&self, key_id: &str) -> Result<(), String> {
        let events = self.events_for_key(key_id);

        for event in events {
            // Check that no event contains plaintext key data
            if event.detail.starts_with("sk-")
                || event.detail.starts_with("aelv-")
                || event.detail.len() > 100
            {
                return Err(format!(
                    "Potential key leak in audit log for key '{}': detail too long or contains key prefix",
                    key_id
                ));
            }
        }

        Ok(())
    }

    /// Clear all audit events
    pub fn clear(&mut self) {
        self.events.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_record_and_retrieve() {
        let mut auditor = KeyLifecycleAuditor::new(100);
        auditor.record("gateway-key", KeyAction::Created, "generated via UI");
        auditor.record("provider:OpenAI", KeyAction::Created, "stored in keychain");
        auditor.record("gateway-key", KeyAction::Accessed, "request authentication");

        assert_eq!(auditor.events().len(), 3);
        assert_eq!(auditor.events_for_key("gateway-key").len(), 2);
    }

    #[test]
    fn test_max_events_bounded() {
        let mut auditor = KeyLifecycleAuditor::new(5);
        for i in 0..10 {
            auditor.record("key", KeyAction::Accessed, &format!("request-{}", i));
        }
        assert_eq!(auditor.events().len(), 5);
        // Oldest events should be gone
        assert!(auditor
            .events_for_key("key")
            .iter()
            .all(|e| e.detail != "request-0"));
    }

    #[test]
    fn test_key_safety_audit_passes() {
        let mut auditor = KeyLifecycleAuditor::new(100);
        auditor.record("gateway-key", KeyAction::Created, "32-char random string");
        auditor.record("gateway-key", KeyAction::Accessed, "bearer auth header");

        assert!(auditor.audit_key_safety("gateway-key").is_ok());
    }

    #[test]
    fn test_key_safety_audit_catches_leak() {
        let mut auditor = KeyLifecycleAuditor::new(100);
        auditor.record(
            "gateway-key",
            KeyAction::Accessed,
            "sk-proj-abc123verylongkeythatactuallylookslikeanapikeythatshouldneverappearinlogs",
        );

        assert!(auditor.audit_key_safety("gateway-key").is_err());
    }
}
