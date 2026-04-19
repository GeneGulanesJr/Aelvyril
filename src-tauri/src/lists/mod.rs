use serde::{Deserialize, Serialize};
use std::sync::Arc;

use parking_lot::Mutex;
use regex::Regex;

/// A single list rule (regex pattern with a label)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListRule {
    pub id: String,
    pub pattern: String,
    pub label: String,
    pub created_at: String,
    pub enabled: bool,
}

/// The allow/deny list manager
pub struct ListManager {
    allowlist: Arc<Mutex<Vec<ListRule>>>,
    denylist: Arc<Mutex<Vec<ListRule>>>,
}

impl Default for ListManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ListManager {
    pub fn new() -> Self {
        Self {
            allowlist: Arc::new(Mutex::new(Vec::new())),
            denylist: Arc::new(Mutex::new(Vec::new())),
        }
    }

    // ── Allowlist ──────────────────────────────────────────

    pub fn add_allow(&self, pattern: &str, label: &str) -> Result<ListRule, String> {
        // Validate the regex
        Regex::new(pattern).map_err(|e| format!("Invalid regex: {}", e))?;

        let rule = ListRule {
            id: uuid::Uuid::new_v4().to_string(),
            pattern: pattern.to_string(),
            label: label.to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            enabled: true,
        };

        self.allowlist.lock().push(rule.clone());
        Ok(rule)
    }

    pub fn remove_allow(&self, id: &str) {
        self.allowlist.lock().retain(|r| r.id != id);
    }

    pub fn list_allow(&self) -> Vec<ListRule> {
        self.allowlist.lock().clone()
    }

    pub fn update_allow(&self, id: &str, enabled: bool) {
        if let Some(rule) = self.allowlist.lock().iter_mut().find(|r| r.id == id) {
            rule.enabled = enabled;
        }
    }

    // ── Denylist ───────────────────────────────────────────

    pub fn add_deny(&self, pattern: &str, label: &str) -> Result<ListRule, String> {
        Regex::new(pattern).map_err(|e| format!("Invalid regex: {}", e))?;

        let rule = ListRule {
            id: uuid::Uuid::new_v4().to_string(),
            pattern: pattern.to_string(),
            label: label.to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            enabled: true,
        };

        self.denylist.lock().push(rule.clone());
        Ok(rule)
    }

    pub fn remove_deny(&self, id: &str) {
        self.denylist.lock().retain(|r| r.id != id);
    }

    pub fn list_deny(&self) -> Vec<ListRule> {
        self.denylist.lock().clone()
    }

    pub fn update_deny(&self, id: &str, enabled: bool) {
        if let Some(rule) = self.denylist.lock().iter_mut().find(|r| r.id == id) {
            rule.enabled = enabled;
        }
    }

    // ── Export/Import ──────────────────────────────────────

    /// Export both lists as JSON
    pub fn export(&self) -> String {
        let data = serde_json::json!({
            "allowlist": *self.allowlist.lock(),
            "denylist": *self.denylist.lock(),
        });
        serde_json::to_string_pretty(&data).unwrap_or_default()
    }

    /// Import lists from JSON
    pub fn import(&self, json: &str) -> Result<(), String> {
        #[derive(Deserialize)]
        struct Lists {
            #[allow(dead_code)]
            allowlist: Vec<ListRule>,
            #[allow(dead_code)]
            denylist: Vec<ListRule>,
        }

        let lists: Lists =
            serde_json::from_str(json).map_err(|e| format!("Invalid JSON: {}", e))?;

        *self.allowlist.lock() = lists.allowlist;
        *self.denylist.lock() = lists.denylist;
        Ok(())
    }

    /// Get compiled regex patterns from the allowlist (enabled only)
    pub fn get_allow_patterns(&self) -> Vec<Regex> {
        self.allowlist
            .lock()
            .iter()
            .filter(|r| r.enabled)
            .filter_map(|r| Regex::new(&r.pattern).ok())
            .collect()
    }

    /// Get compiled regex patterns from the denylist (enabled only)
    pub fn get_deny_patterns(&self) -> Vec<Regex> {
        self.denylist
            .lock()
            .iter()
            .filter(|r| r.enabled)
            .filter_map(|r| Regex::new(&r.pattern).ok())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add_and_list_allow() {
        let mgr = ListManager::new();
        let rule = mgr.add_allow(r"example\.com", "Company domain").unwrap();
        let rules = mgr.list_allow();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].id, rule.id);
        assert_eq!(rules[0].pattern, r"example\.com");
        assert!(rules[0].enabled);
    }

    #[test]
    fn test_add_and_list_deny() {
        let mgr = ListManager::new();
        let _rule = mgr
            .add_deny(r"PROJECT_\w+", "Internal project codes")
            .unwrap();
        let rules = mgr.list_deny();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].label, "Internal project codes");
    }

    #[test]
    fn test_invalid_regex_rejected() {
        let mgr = ListManager::new();
        let result = mgr.add_allow("[invalid", "Bad pattern");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid regex"));
    }

    #[test]
    fn test_remove_rule() {
        let mgr = ListManager::new();
        let rule = mgr.add_allow(r"test\.com", "Test").unwrap();
        assert_eq!(mgr.list_allow().len(), 1);
        mgr.remove_allow(&rule.id);
        assert_eq!(mgr.list_allow().len(), 0);
    }

    #[test]
    fn test_toggle_rule() {
        let mgr = ListManager::new();
        let rule = mgr.add_allow(r"test\.com", "Test").unwrap();
        assert!(mgr.list_allow()[0].enabled);
        mgr.update_allow(&rule.id, false);
        assert!(!mgr.list_allow()[0].enabled);
    }

    #[test]
    fn test_disabled_rule_excluded_from_patterns() {
        let mgr = ListManager::new();
        mgr.add_allow(r"enabled\.com", "Enabled").unwrap();
        let disabled = mgr.add_allow(r"disabled\.com", "Disabled").unwrap();
        mgr.update_allow(&disabled.id, false);

        let patterns = mgr.get_allow_patterns();
        assert_eq!(patterns.len(), 1);
        assert!(patterns[0].is_match("user@enabled.com"));
    }

    #[test]
    fn test_export_and_import() {
        let mgr = ListManager::new();
        mgr.add_allow(r"safe\.com", "Safe domain").unwrap();
        mgr.add_deny(r"SECRET_\d+", "Secret codes").unwrap();

        let exported = mgr.export();
        // JSON serialization preserves the regex pattern
        assert!(exported.contains("safe"));
        assert!(exported.contains("SECRET"));
        assert!(exported.contains("allowlist"));
        assert!(exported.contains("denylist"));

        // Import into fresh manager
        let mgr2 = ListManager::new();
        mgr2.import(&exported).unwrap();
        assert_eq!(mgr2.list_allow().len(), 1);
        assert_eq!(mgr2.list_deny().len(), 1);
    }

    #[test]
    fn test_import_invalid_json() {
        let mgr = ListManager::new();
        let result = mgr.import("not json");
        assert!(result.is_err());
    }

    #[test]
    fn test_allow_pattern_matching() {
        let mgr = ListManager::new();
        mgr.add_allow(r"noreply@.*\.example\.com", "No-reply emails")
            .unwrap();
        let patterns = mgr.get_allow_patterns();
        assert!(patterns[0].is_match("noreply@corp.example.com"));
        assert!(!patterns[0].is_match("user@gmail.com"));
    }

    #[test]
    fn test_deny_pattern_matching() {
        let mgr = ListManager::new();
        mgr.add_deny(r"\b\d{3}-\d{2}-\d{4}\b", "SSN pattern")
            .unwrap();
        let patterns = mgr.get_deny_patterns();
        assert!(patterns[0].is_match("123-45-6789"));
        assert!(!patterns[0].is_match("123-456-7890")); // 10 digits, not SSN
    }
}
