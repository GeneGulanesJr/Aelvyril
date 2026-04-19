use std::path::Path;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use parking_lot::Mutex;

// ── Audit Table Column Indices ──

/// Column indices for the audit_entries SELECT query.
/// Must stay in sync with the column order in `get_all()` and `get_stats()`.
mod col {
    pub const ID: usize = 0;
    pub const TIMESTAMP: usize = 1;
    pub const SESSION_ID: usize = 2;
    pub const PROVIDER: usize = 3;
    pub const MODEL: usize = 4;
    pub const ENTITY_TYPES: usize = 5;
    pub const TOTAL_ENTITIES: usize = 6;
    pub const STREAMING: usize = 7;
    pub const TOKENS_GENERATED: usize = 8;
}
use rusqlite::{params, Connection};
use serde_json;

use super::AuditEntry;

/// Persistent audit log store backed by SQLite.
/// Never stores original PII — only token types and metadata.
pub struct AuditStore {
    conn: Arc<Mutex<Connection>>,
}

impl AuditStore {
    /// Open (or create) the audit database at the given path.
    pub fn open(db_path: &Path) -> Result<Self, String> {
        let conn =
            Connection::open(db_path).map_err(|e| format!("Failed to open audit DB: {}", e))?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS audit_entries (
                id              TEXT PRIMARY KEY,
                timestamp       TEXT NOT NULL,
                session_id      TEXT NOT NULL,
                provider        TEXT NOT NULL,
                model           TEXT NOT NULL,
                entity_types    TEXT NOT NULL,
                total_entities  INTEGER NOT NULL,
                streaming       INTEGER NOT NULL,
                tokens_generated TEXT NOT NULL DEFAULT '[]'
            );

            CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_entries(timestamp);
            CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_entries(session_id);",
        )
        .map_err(|e| format!("Failed to create audit schema: {}", e))?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Insert a new audit entry.
    pub fn insert(&self, entry: &AuditEntry) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO audit_entries (id, timestamp, session_id, provider, model, entity_types, total_entities, streaming, tokens_generated)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                entry.id,
                entry.timestamp.to_rfc3339(),
                entry.session_id,
                entry.provider,
                entry.model,
                serde_json::to_string(&entry.entity_types).unwrap_or_else(|_| "[]".into()),
                entry.total_entities,
                entry.streaming as i32,
                serde_json::to_string(&entry.tokens_generated).unwrap_or_else(|_| "[]".into()),
            ],
        )
        .map_err(|e| format!("Failed to insert audit entry: {}", e))?;
        Ok(())
    }

    /// Get all audit entries, newest first.
    pub fn get_all(&self) -> Result<Vec<AuditEntry>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, timestamp, session_id, provider, model, entity_types, total_entities, streaming, tokens_generated
                 FROM audit_entries ORDER BY timestamp DESC",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let entries = stmt
            .query_map([], |row| {
                let id: String = row.get(col::ID)?;
                let timestamp_str: String = row.get(col::TIMESTAMP)?;
                let session_id: String = row.get(col::SESSION_ID)?;
                let provider: String = row.get(col::PROVIDER)?;
                let model: String = row.get(col::MODEL)?;
                let entity_types_str: String = row.get(col::ENTITY_TYPES)?;
                let total_entities: i32 = row.get(col::TOTAL_ENTITIES)?;
                let streaming: i32 = row.get(col::STREAMING)?;
                let tokens_str: String = row.get(col::TOKENS_GENERATED)?;

                let timestamp = DateTime::parse_from_rfc3339(&timestamp_str)
                    .map(|dt| dt.to_utc())
                    .unwrap_or_else(|_| Utc::now());

                let entity_types: Vec<(String, usize)> =
                    serde_json::from_str(&entity_types_str).unwrap_or_default();

                let tokens_generated: Vec<String> =
                    serde_json::from_str(&tokens_str).unwrap_or_default();

                Ok(AuditEntry {
                    id,
                    timestamp,
                    session_id,
                    provider,
                    model,
                    entity_types,
                    total_entities: total_entities as usize,
                    streaming: streaming != 0,
                    tokens_generated,
                })
            })
            .map_err(|e| format!("Failed to query audit entries: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(entries)
    }

    /// Get the count of entries.
    pub fn count(&self) -> Result<usize, String> {
        let conn = self.conn.lock();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM audit_entries", [], |row| row.get(0))
            .map_err(|e| format!("Failed to count entries: {}", e))?;
        Ok(count as usize)
    }

    /// Get aggregate stats for the dashboard.
    pub fn get_stats(&self) -> Result<AuditStats, String> {
        let conn = self.conn.lock();

        let total_requests: i64 = conn
            .query_row("SELECT COUNT(*) FROM audit_entries", [], |row| row.get(0))
            .unwrap_or(0);

        let total_entities: i64 = conn
            .query_row("SELECT SUM(total_entities) FROM audit_entries", [], |row| {
                row.get(0)
            })
            .unwrap_or(0);

        let entity_breakdown: Vec<(String, i64)> = {
            let mut stmt = conn
                .prepare("SELECT entity_types FROM audit_entries")
                .map_err(|e| format!("Stats query failed: {}", e))?;

            let rows: Vec<String> = stmt
                .query_map([], |row| row.get(0))
                .map_err(|e| format!("Stats query failed: {}", e))?
                .filter_map(|r| r.ok())
                .collect();

            let mut counts: std::collections::HashMap<String, i64> =
                std::collections::HashMap::new();
            for row in rows {
                let pairs: Vec<(String, usize)> = serde_json::from_str(&row).unwrap_or_default();
                for (entity_type, count) in pairs {
                    *counts.entry(entity_type).or_insert(0) += count as i64;
                }
            }
            counts.into_iter().collect()
        };

        Ok(AuditStats {
            total_requests: total_requests as usize,
            total_entities: total_entities as usize,
            entity_breakdown,
        })
    }

    /// Clear all audit entries.
    pub fn clear_all(&self) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM audit_entries", [])
            .map_err(|e| format!("Failed to clear audit log: {}", e))?;
        Ok(())
    }

    /// Export audit entries as JSON (sanitized — no raw values).
    pub fn export_json(&self) -> Result<String, String> {
        let entries = self.get_all()?;
        serde_json::to_string_pretty(&entries).map_err(|e| format!("Failed to serialize: {}", e))
    }

    /// Export audit entries as CSV (sanitized).
    pub fn export_csv(&self) -> Result<String, String> {
        let entries = self.get_all()?;
        let mut csv = String::from(
            "id,timestamp,session_id,provider,model,total_entities,streaming,entity_types,tokens\n",
        );
        for e in &entries {
            let entity_summary: String = e
                .entity_types
                .iter()
                .map(|(t, c)| format!("{}:{}", t, c))
                .collect::<Vec<_>>()
                .join(";");
            csv.push_str(&format!(
                "{},{},{},{},{},{},{},\"{}\",\"{}\"\n",
                e.id,
                e.timestamp.to_rfc3339(),
                e.session_id,
                e.provider,
                e.model,
                e.total_entities,
                e.streaming,
                entity_summary,
                e.tokens_generated.join(";"),
            ));
        }
        Ok(csv)
    }
}

/// Aggregate stats for the dashboard
#[derive(Debug, Clone, serde::Serialize)]
pub struct AuditStats {
    pub total_requests: usize,
    pub total_entities: usize,
    pub entity_breakdown: Vec<(String, i64)>,
}
