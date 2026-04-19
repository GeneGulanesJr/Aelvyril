use std::path::Path;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use rusqlite::{params, Connection};

use super::{TokenCountSource, TokenUsageEvent};

/// Column indices for the token_usage_events SELECT query.
mod col {
    pub const EVENT_ID: usize = 0;
    pub const SCHEMA_VERSION: usize = 1;
    pub const TIMESTAMP: usize = 2;
    pub const SESSION_ID: usize = 3;
    pub const TENANT_ID: usize = 4;
    pub const TOOL_NAME: usize = 5;
    pub const MODEL_ID: usize = 6;
    pub const RETRY_ATTEMPT: usize = 7;
    pub const TOKENS_IN_SYSTEM: usize = 8;
    pub const TOKENS_IN_USER: usize = 9;
    pub const TOKENS_IN_CACHED: usize = 10;
    pub const TOKENS_OUT: usize = 11;
    pub const TOKENS_TRUNCATED: usize = 12;
    pub const TOKEN_COUNT_SOURCE: usize = 13;
    pub const WAS_STREAMED: usize = 14;
    pub const WAS_PARTIAL: usize = 15;
    pub const DURATION_MS: usize = 16;
    pub const COST_ESTIMATE_CENTS: usize = 17;
    pub const PRICING_AS_OF: usize = 18;
    pub const COST_UNAVAILABLE: usize = 19;
    pub const SUCCESS: usize = 20;
}

/// Persistent token usage event store backed by SQLite.
///
/// Stores individual events for L3 trend analysis and audit purposes.
/// Events are retained for 30 days by default, aggregates indefinitely.
pub struct TokenUsageStore {
    conn: Arc<Mutex<rusqlite::Connection>>,
}

// TokenUsageStore is Clone because the inner conn is Arc — cloning just bumps the ref count.
impl Clone for TokenUsageStore {
    fn clone(&self) -> Self {
        Self {
            conn: Arc::clone(&self.conn),
        }
    }
}

impl TokenUsageStore {
    /// Open (or create) the token usage database.
    pub fn open(db_path: &Path) -> Result<Self, String> {
        let conn = Connection::open(db_path)
            .map_err(|e| format!("Failed to open token usage DB: {}", e))?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS token_usage_events (
                event_id             TEXT PRIMARY KEY,
                schema_version       INTEGER NOT NULL,
                timestamp            TEXT NOT NULL,
                session_id           TEXT NOT NULL,
                tenant_id            TEXT NOT NULL,
                tool_name            TEXT NOT NULL,
                model_id             TEXT NOT NULL,
                retry_attempt        INTEGER NOT NULL DEFAULT 0,
                tokens_in_system     INTEGER NOT NULL DEFAULT 0,
                tokens_in_user       INTEGER NOT NULL DEFAULT 0,
                tokens_in_cached     INTEGER NOT NULL DEFAULT 0,
                tokens_out           INTEGER NOT NULL DEFAULT 0,
                tokens_truncated     INTEGER NOT NULL DEFAULT 0,
                token_count_source   TEXT NOT NULL DEFAULT 'api_reported',
                was_streamed         INTEGER NOT NULL DEFAULT 0,
                was_partial          INTEGER NOT NULL DEFAULT 0,
                duration_ms         INTEGER NOT NULL DEFAULT 0,
                cost_estimate_cents  INTEGER NOT NULL DEFAULT 0,
                pricing_as_of        TEXT NOT NULL DEFAULT '',
                cost_unavailable     INTEGER NOT NULL DEFAULT 0,
                success              INTEGER NOT NULL DEFAULT 1
            );

            CREATE INDEX IF NOT EXISTS idx_tu_timestamp ON token_usage_events(timestamp);
            CREATE INDEX IF NOT EXISTS idx_tu_session ON token_usage_events(session_id);
            CREATE INDEX IF NOT EXISTS idx_tu_model ON token_usage_events(model_id);
            CREATE INDEX IF NOT EXISTS idx_tu_tool ON token_usage_events(tool_name);",
        )
        .map_err(|e| format!("Failed to create token usage schema: {}", e))?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Insert a new token usage event (idempotent upsert on event_id).
    pub fn insert(&self, event: &TokenUsageEvent) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR IGNORE INTO token_usage_events (
                event_id, schema_version, timestamp, session_id, tenant_id,
                tool_name, model_id, retry_attempt,
                tokens_in_system, tokens_in_user, tokens_in_cached, tokens_out, tokens_truncated,
                token_count_source, was_streamed, was_partial,
                duration_ms, cost_estimate_cents, pricing_as_of, cost_unavailable, success
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
            params![
                event.event_id,
                event.schema_version,
                event.timestamp.to_rfc3339(),
                event.session_id,
                event.tenant_id,
                event.tool_name,
                event.model_id,
                event.retry_attempt,
                event.tokens_in_system,
                event.tokens_in_user,
                event.tokens_in_cached,
                event.tokens_out,
                event.tokens_truncated,
                serde_json::to_string(&event.token_count_source).unwrap_or_else(|_| "\"api_reported\"".into()),
                event.was_streamed as i32,
                event.was_partial as i32,
                event.duration_ms,
                event.cost_estimate_cents,
                event.pricing_as_of,
                event.cost_unavailable as i32,
                event.success as i32,
            ],
        )
        .map_err(|e| format!("Failed to insert token usage event: {}", e))?;
        Ok(())
    }

    /// Purge events older than N days (retention policy).
    pub fn purge_older_than_days(&self, days: u32) -> Result<u64, String> {
        let conn = self.conn.lock();
        let cutoff = Utc::now() - chrono::Duration::days(days as i64);
        let cutoff_str = cutoff.to_rfc3339();
        let count = conn
            .execute(
                "DELETE FROM token_usage_events WHERE timestamp < ?1",
                params![cutoff_str],
            )
            .map_err(|e| format!("Failed to purge old events: {}", e))?;
        Ok(count as u64)
    }

    /// Get event count.
    pub fn count(&self) -> Result<usize, String> {
        let conn = self.conn.lock();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM token_usage_events",
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to count token usage events: {}", e))?;
        Ok(count as usize)
    }

    /// Clear all token usage events.
    pub fn clear_all(&self) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM token_usage_events", [])
            .map_err(|e| format!("Failed to clear token usage events: {}", e))?;
        Ok(())
    }

    /// Export events as JSON (sanitized — no raw content).
    pub fn export_json(&self) -> Result<String, String> {
        let events = self.get_recent(1000)?;
        serde_json::to_string_pretty(&events).map_err(|e| format!("Failed to serialize: {}", e))
    }

    /// Get the N most recent events.
    pub fn get_recent(&self, limit: usize) -> Result<Vec<TokenUsageEvent>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT event_id, schema_version, timestamp, session_id, tenant_id,
                        tool_name, model_id, retry_attempt,
                        tokens_in_system, tokens_in_user, tokens_in_cached, tokens_out, tokens_truncated,
                        token_count_source, was_streamed, was_partial,
                        duration_ms, cost_estimate_cents, pricing_as_of, cost_unavailable, success
                 FROM token_usage_events ORDER BY timestamp DESC LIMIT ?1",
            )
            .map_err(|e| format!("Failed to prepare query: {}", e))?;

        let events = stmt
            .query_map(params![limit as i64], |row| {
                let event_id: String = row.get(col::EVENT_ID)?;
                let schema_version: i32 = row.get(col::SCHEMA_VERSION)?;
                let timestamp_str: String = row.get(col::TIMESTAMP)?;
                let session_id: String = row.get(col::SESSION_ID)?;
                let tenant_id: String = row.get(col::TENANT_ID)?;
                let tool_name: String = row.get(col::TOOL_NAME)?;
                let model_id: String = row.get(col::MODEL_ID)?;
                let retry_attempt: i32 = row.get(col::RETRY_ATTEMPT)?;
                let tokens_in_system: i64 = row.get(col::TOKENS_IN_SYSTEM)?;
                let tokens_in_user: i64 = row.get(col::TOKENS_IN_USER)?;
                let tokens_in_cached: i64 = row.get(col::TOKENS_IN_CACHED)?;
                let tokens_out: i64 = row.get(col::TOKENS_OUT)?;
                let tokens_truncated: i64 = row.get(col::TOKENS_TRUNCATED)?;
                let token_count_source_str: String = row.get(col::TOKEN_COUNT_SOURCE)?;
                let was_streamed: i32 = row.get(col::WAS_STREAMED)?;
                let was_partial: i32 = row.get(col::WAS_PARTIAL)?;
                let duration_ms: i64 = row.get(col::DURATION_MS)?;
                let cost_estimate_cents: i64 = row.get(col::COST_ESTIMATE_CENTS)?;
                let pricing_as_of: String = row.get(col::PRICING_AS_OF)?;
                let cost_unavailable: i32 = row.get(col::COST_UNAVAILABLE)?;
                let success: i32 = row.get(col::SUCCESS)?;

                let timestamp = DateTime::parse_from_rfc3339(&timestamp_str)
                    .map(|dt| dt.to_utc())
                    .unwrap_or_else(|_| Utc::now());

                let token_count_source: TokenCountSource =
                    serde_json::from_str(&token_count_source_str)
                        .unwrap_or(TokenCountSource::ApiReported);

                Ok(TokenUsageEvent {
                    event_id,
                    schema_version: schema_version as u32,
                    timestamp,
                    session_id,
                    tenant_id,
                    tool_name,
                    model_id,
                    retry_attempt: retry_attempt as u32,
                    tokens_in_system: tokens_in_system as u64,
                    tokens_in_user: tokens_in_user as u64,
                    tokens_in_cached: tokens_in_cached as u64,
                    tokens_out: tokens_out as u64,
                    tokens_truncated: tokens_truncated as u64,
                    token_count_source,
                    was_streamed: was_streamed != 0,
                    was_partial: was_partial != 0,
                    duration_ms: duration_ms as u64,
                    cost_estimate_cents: cost_estimate_cents as u64,
                    pricing_as_of,
                    cost_unavailable: cost_unavailable != 0,
                    success: success != 0,
                })
            })
            .map_err(|e| format!("Failed to query token usage events: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        Ok(events)
    }
}