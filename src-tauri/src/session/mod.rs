use dashmap::DashMap;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

use crate::pseudonym::mapping::MappingTable;
use crate::pii::engine::summarize_matches;
use crate::pii::recognizers::PiiMatch;

/// A single conversation session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub last_activity: chrono::DateTime<chrono::Utc>,
    pub request_count: u64,
    pub entities_detected: u64,
    pub provider: Option<String>,
    pub model: Option<String>,
}

/// An audit log entry — never stores original sensitive values
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: String,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub session_id: String,
    pub provider: String,
    pub model: String,
    pub entity_types: Vec<(String, usize)>,
    pub total_entities: usize,
    pub streaming: bool,
}

/// Manages all sessions, mapping tables, and audit entries
pub struct SessionManager {
    sessions: Arc<DashMap<String, Session>>,
    mapping_tables: Arc<DashMap<String, MappingTable>>,
    audit_log: Arc<Mutex<Vec<AuditEntry>>>,
    timeout: Duration,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(DashMap::new()),
            mapping_tables: Arc::new(DashMap::new()),
            audit_log: Arc::new(Mutex::new(Vec::new())),
            timeout: Duration::from_secs(30 * 60), // 30 minutes
        }
    }

    /// Get or create a session for a client
    pub fn get_or_create_session(
        &self,
        session_id: &str,
        provider: Option<&str>,
        model: Option<&str>,
    ) -> Session {
        let now = chrono::Utc::now();

        self.sessions
            .entry(session_id.to_string())
            .and_modify(|session| {
                session.last_activity = now;
                if provider.is_some() {
                    session.provider = provider.map(String::from);
                }
                if model.is_some() {
                    session.model = model.map(String::from);
                }
            })
            .or_insert_with(|| {
                // Create mapping table for new session
                self.mapping_tables
                    .insert(session_id.to_string(), MappingTable::with_default_ttl());

                Session {
                    id: session_id.to_string(),
                    created_at: now,
                    last_activity: now,
                    request_count: 0,
                    entities_detected: 0,
                    provider: provider.map(String::from),
                    model: model.map(String::from),
                }
            })
            .value()
            .clone()
    }

    /// Get the mapping table for a session
    pub fn get_mapping_table(&self, session_id: &str) -> Option<MappingTable> {
        self.mapping_tables.get(session_id).map(|r| r.value().clone())
    }

    /// Update the mapping table for a session
    pub fn update_mapping_table(&self, session_id: &str, table: MappingTable) {
        self.mapping_tables.insert(session_id.to_string(), table);
    }

    /// Get mutable access to a mapping table
    pub fn with_mapping_table<F, R>(&self, session_id: &str, f: F) -> Option<R>
    where
        F: FnOnce(&mut MappingTable) -> R,
    {
        let mut entry = self.mapping_tables.get_mut(session_id)?;
        Some(f(entry.value_mut()))
    }

    /// Record a request in a session
    pub fn record_request(
        &self,
        session_id: &str,
        provider: &str,
        model: &str,
        matches: &[PiiMatch],
        streaming: bool,
    ) {
        // Update session
        if let Some(mut session) = self.sessions.get_mut(session_id) {
            session.request_count += 1;
            session.entities_detected += matches.len() as u64;
            session.last_activity = chrono::Utc::now();
        }

        // Add audit entry
        let summary = summarize_matches(matches);
        let entity_types: Vec<(String, usize)> = summary.into_iter().collect();

        let entry = AuditEntry {
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: chrono::Utc::now(),
            session_id: session_id.to_string(),
            provider: provider.to_string(),
            model: model.to_string(),
            entity_types,
            total_entities: matches.len(),
            streaming,
        };

        self.audit_log.lock().push(entry);
    }

    /// Clear a specific session
    pub fn clear(&self, session_id: &str) {
        self.sessions.remove(session_id);
        self.mapping_tables.remove(session_id);
    }

    /// Expire sessions past the timeout
    pub fn expire_sessions(&self) {
        let cutoff = chrono::Utc::now() - chrono::Duration::from_std(self.timeout).unwrap_or_default();
        self.sessions.retain(|_, session| session.last_activity > cutoff);
    }

    /// Count active sessions
    pub fn active_count(&self) -> usize {
        self.sessions.len()
    }

    /// List all sessions
    pub fn list(&self) -> Vec<serde_json::Value> {
        self.sessions
            .iter()
            .map(|r| {
                let s = r.value();
                serde_json::json!({
                    "id": s.id,
                    "created_at": s.created_at.to_rfc3339(),
                    "last_activity": s.last_activity.to_rfc3339(),
                    "request_count": s.request_count,
                    "entities_detected": s.entities_detected,
                    "provider": s.provider,
                    "model": s.model,
                })
            })
            .collect()
    }

    /// Get audit log entries
    pub fn audit_log(&self) -> Vec<serde_json::Value> {
        self.audit_log
            .lock()
            .iter()
            .map(|entry| {
                serde_json::json!({
                    "id": entry.id,
                    "timestamp": entry.timestamp.to_rfc3339(),
                    "session_id": entry.session_id,
                    "provider": entry.provider,
                    "model": entry.model,
                    "entity_types": entry.entity_types,
                    "total_entities": entry.total_entities,
                    "streaming": entry.streaming,
                })
            })
            .collect()
    }
}

// Need Clone for MappingTable since DashMap requires it for with_mapping_table
impl Clone for MappingTable {
    fn clone(&self) -> Self {
        Self {
            mappings: self.mappings.clone(),
            last_accessed: self.last_accessed.clone(),
            ttl: self.ttl,
        }
    }
}
