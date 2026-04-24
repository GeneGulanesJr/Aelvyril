pub mod aggregator;
pub mod alerts;
pub mod pricing;
pub mod store;
pub mod tracker;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Schema version for migration support. Bump on breaking changes.
/// v1: Initial schema.
/// v2: Added `actual_cost_cents` and `tokens_in_cache_write`.
///
/// Schema evolution policy:
/// - Non-breaking additions (new optional fields): no version bump needed
/// - Breaking changes (removed/renamed fields, type changes): MUST bump version
/// - Consumers MUST check `schema_version` before parsing — `row_to_event()`
///   in store.rs silently skips events with unsupported versions
/// - Migration guide: see `docs/TOKEN_USAGE_MIGRATION_GUIDE.md`
pub const TOKEN_USAGE_SCHEMA_VERSION: u32 = 2;

/// Default tenant ID for single-tenant deployments.
pub const DEFAULT_TENANT_ID: &str = "default";

// ── Tool Name Enumeration ─────────────────────────────────────────────────────

/// Known tool names that trigger LLM calls.
/// New values must be added here AND to the plan document before use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolName {
    /// OpenAI-compatible `/v1/chat/completions` endpoint.
    ChatCompletions,
    /// Direct proxy pass-through (no PII processing).
    Passthrough,
    /// Orchestrator planning model call.
    OrchestratorPlan,
    /// Orchestrator executor model call.
    OrchestratorExecute,
}

impl ToolName {
    /// Convert to the string representation stored in events/DB.
    pub fn as_str(&self) -> &'static str {
        match self {
            ToolName::ChatCompletions => "chat_completions",
            ToolName::Passthrough => "passthrough",
            ToolName::OrchestratorPlan => "orchestrator_plan",
            ToolName::OrchestratorExecute => "orchestrator_execute",
        }
    }
}

impl std::fmt::Display for ToolName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl From<ToolName> for String {
    fn from(val: ToolName) -> String {
        val.as_str().to_string()
    }
}

// ── Token Count Source ──────────────────────────────────────────────────────

/// How token counts were obtained.
///
/// - `api_reported`: The model API returned `usage` data (most accurate).
/// - `estimated`: Local estimation (e.g., tiktoken) was used because the
///   API didn't report counts.
/// - `unavailable`: No token counts are available (self-hosted models,
///   partial failures). Use `null` in serialized output, **not** `0`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenCountSource {
    ApiReported,
    Estimated,
    Unavailable,
}

// ── Session Lifecycle ───────────────────────────────────────────────────────

/// Lifecycle state of a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Active,
    Closed,
    Orphaned,
}

// ── Token Usage Event ────────────────────────────────────────────────────────

/// A single token usage event — one per LLM call.
///
/// **Privacy guarantee:** Never stores raw content, user messages, or model
/// responses. Only aggregate token counts and metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsageEvent {
    // === Identity ===
    /// Schema version for migration support.
    pub schema_version: u32,
    /// UUID for deduplication (idempotent upsert).
    pub event_id: String,
    /// Server-side timestamp.
    pub timestamp: DateTime<Utc>,
    /// Opaque, non-sequential session ID (UUID v4).
    pub session_id: String,
    /// Tenant isolation. Uses DEFAULT_TENANT_ID for single-tenant.
    pub tenant_id: String,

    // === Call details ===
    /// Which tool triggered this LLM call (e.g. "chat_completions", "passthrough").
    pub tool_name: String,
    /// Which model was called (e.g., "gpt-4o", "claude-3-opus").
    pub model_id: String,
    /// 0 = first attempt, 1+ = retry.
    pub retry_attempt: u32,

    // === Token counts ===
    /// System prompt tokens (fixed overhead, not user-controlled).
    pub tokens_in_system: u64,
    /// User/context tokens (what the user sent).
    pub tokens_in_user: u64,
    /// Cached prompt tokens (discounted rate).
    pub tokens_in_cached: u64,
    /// Completion tokens generated.
    pub tokens_out: u64,
    /// Tokens discarded due to context window overflow.
    pub tokens_truncated: u64,

    // === Token count provenance ===
    /// How token counts were obtained.
    pub token_count_source: TokenCountSource,

    // === Streaming & completion state ===
    /// Was this a streaming response?
    pub was_streamed: bool,
    /// Did the stream crash/disconnect before completion?
    pub was_partial: bool,

    // === Latency ===
    /// Wall-clock time from request sent to response complete (ms).
    pub duration_ms: u64,

    // === Cost ===
    /// Cost reported by the provider itself (e.g., Anthropic, Google).
    /// `None` when the provider doesn’t report cost directly.
    /// **Prefer this over `cost_estimate_cents` when available.**
    pub actual_cost_cents: Option<u64>,
    /// Cost calculated from token counts × pricing table.
    /// Used as fallback when `actual_cost_cents` is `None`.
    /// e.g., $0.42 → 42 (integer cents, never float).
    pub cost_estimate_cents: u64,
    /// Date the pricing table was last verified (ISO date string, e.g. "2025-01-15").
    pub pricing_as_of: String,
    /// True if pricing data was missing for this model.
    pub cost_unavailable: bool,

    // === Cache token breakdown ===
    /// Cache-write tokens (typically 25% MORE expensive than fresh input).
    /// When present, `tokens_in_cached` = cache-read tokens only.
    /// Not all providers report this separately.
    pub tokens_in_cache_write: u64,

    // === Outcome ===
    /// Did the call complete normally?
    pub success: bool,
}

// ── L1: Per-Session Totals ──────────────────────────────────────────────────

/// L1 aggregation: per-session totals.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionTokenStats {
    pub session_id: String,
    pub tenant_id: String,
    pub status: SessionStatus,
    pub duration_seconds: u64,

    pub tokens_in_system: u64,
    pub tokens_in_user: u64,
    pub tokens_in_cached: u64,
    pub tokens_out: u64,
    pub tokens_truncated: u64,
    pub tokens_in_cache_write: u64,

    /// Provider-reported cost in cents (null when unavailable).
    pub actual_cost_cents: Option<u64>,
    pub cost_estimate_cents: u64,
    pub cost_unavailable: bool,

    pub truncation_count: u64,
    pub retry_count: u64,
    pub partial_count: u64,
    pub call_count: u64,
    pub success_count: u64,

    pub avg_duration_ms: f64,
    pub p50_duration_ms: f64,
    pub p99_duration_ms: f64,

    // Efficiency (L4)
    pub tokens_saved_vs_full_file_read: u64,
    pub baseline_method: String,
    pub baseline_disclaimer: String,

    pub first_event: Option<DateTime<Utc>>,
    pub last_event: Option<DateTime<Utc>>,
}

// ── L2: Per-Tool Breakdown ──────────────────────────────────────────────────

/// L2 aggregation: per-tool breakdown.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolTokenStats {
    pub tool: String,
    pub tokens_in_system: u64,
    pub tokens_in_user: u64,
    pub tokens_in_cached: u64,
    pub tokens_out: u64,
    pub tokens_truncated: u64,
    pub tokens_in_cache_write: u64,
    /// Provider-reported cost (null when unavailable).
    pub actual_cost_cents: Option<u64>,
    pub cost_estimate_cents: u64,
    pub call_count: u64,
    pub success_rate: f64,
    pub retry_rate: f64,
    pub partial_rate: f64,
    pub avg_duration_ms: f64,
    pub p50_duration_ms: f64,
    pub p99_duration_ms: f64,
    /// Percentage of total tokens (across all tools) consumed by this tool.
    pub pct_of_total: f64,
}

// ── L2: Per-Model Breakdown ─────────────────────────────────────────────────

/// L2 aggregation: per-model breakdown.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelTokenStats {
    pub model_id: String,
    pub tokens_in_system: u64,
    pub tokens_in_user: u64,
    pub tokens_in_cached: u64,
    pub tokens_out: u64,
    pub tokens_in_cache_write: u64,
    /// Provider-reported cost (null when unavailable).
    pub actual_cost_cents: Option<u64>,
    pub cost_estimate_cents: u64,
    pub cost_unavailable: bool,
    pub call_count: u64,
    pub pricing_as_of: String,
    pub avg_duration_ms: f64,
    pub p50_duration_ms: f64,
    pub p99_duration_ms: f64,
}

// ── L3: Trend Data ──────────────────────────────────────────────────────────

/// L3 aggregation: per-day trend data point.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyTokenTrend {
    pub date: String, // YYYY-MM-DD
    pub tokens_in_system: u64,
    pub tokens_in_user: u64,
    pub tokens_in_cached: u64,
    pub tokens_out: u64,
    pub tokens_truncated: u64,
    pub tokens_in_cache_write: u64,
    /// Provider-reported cost for the day (null when no provider reported cost).
    pub actual_cost_cents: Option<u64>,
    pub cost_estimate_cents: u64,
    pub call_count: u64,
    pub success_count: u64,
    pub retry_count: u64,
    pub partial_count: u64,
    pub avg_duration_ms: f64,
    pub truncation_rate: f64,
}

/// L3 aggregation: per-tool per-day trend data point.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolTrendPoint {
    pub date: String,
    pub tool: String,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub cost_estimate_cents: u64,
    pub call_count: u64,
    pub success_rate: f64,
    pub avg_duration_ms: f64,
}

/// L3 aggregation: per-model per-day trend data point.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelTrendPoint {
    pub date: String,
    pub model_id: String,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub tokens_in_cached: u64,
    pub tokens_in_cache_write: u64,
    pub actual_cost_cents: Option<u64>,
    pub cost_estimate_cents: u64,
    pub call_count: u64,
    pub success_rate: f64,
    pub avg_duration_ms: f64,
}

// ── L4: Efficiency Ratios ──────────────────────────────────────────────────

/// L4: Efficiency ratios and suggestions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EfficiencyMetrics {
    /// tokens_in_user / tokens_out (null if tokens_out == 0).
    pub context_to_output_ratio: Option<f64>,
    /// Percentage of input that is system prompt.
    pub system_overhead_pct: f64,
    /// Cost per successful task (null if no successful calls).
    pub cost_per_successful_task_cents: Option<u64>,
    /// Percentage of tokens saved vs baseline.
    pub tokens_saved_pct: f64,
    /// Which baseline was used.
    pub baseline_method: String,
    /// Disclaimer about the baseline.
    pub baseline_disclaimer: String,
    /// Fraction of calls that hit context limits.
    pub truncation_rate: f64,
    /// Suggestion based on current stats.
    pub suggestion: String,
    /// Total tokens divided by number of days with activity.
    /// Normalizes for usage patterns — 10K tokens in one focused day
    /// vs 10K tokens spread over a month tell different stories.
    pub tokens_per_active_day: Option<f64>,
    /// Total cost (estimate cents) divided by number of days with activity.
    pub cost_per_active_day_cents: Option<u64>,
    /// Companion metric: task success quality score (0.0–1.0).
    /// Combines success rate, low retry rate, and low truncation rate.
    /// Higher is better. See TOKEN_USAGE_BASELINE_METHODOLOGY.md.
    pub quality_score: Option<f64>,
}

// ── Full Stats Response ─────────────────────────────────────────────────────

/// The complete stats response (matches Step 5 output format).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenStatsResponse {
    pub session: SessionTokenStats,
    pub by_tool: Vec<ToolTokenStats>,
    pub by_model: Vec<ModelTokenStats>,
    pub daily_trends: Vec<DailyTokenTrend>,
    pub efficiency: EfficiencyMetrics,
    pub meta: TokenStatsMeta,
}

/// Metadata about the stats response (data quality, access level).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenStatsMeta {
    pub schema_version: u32,
    pub token_count_sources: TokenCountSourceBreakdown,
    /// True if local token count estimates diverge from API-reported counts by >1%.
    pub token_count_reconciliation_issue: bool,
    /// True if data may be incomplete (e.g., partial stream, missing events).
    pub incomplete_data: bool,
    /// True if this session was auto-closed after being orphaned (inactive too long).
    pub orphaned: bool,
    /// Access level for this response: "full", "summary", or "redacted".
    /// Controls what detail level the consumer is authorized to see.
    /// - "full": all fields visible (admin)
    /// - "summary": aggregated totals only, no per-call detail (standard user)
    /// - "redacted": tool names generalized, no cost detail (external)
    pub access_level: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenCountSourceBreakdown {
    pub api_reported: u64,
    pub estimated: u64,
    pub unavailable: u64,
}

// ── Global Stats (across all sessions) ───────────────────────────────────────

/// Global stats across all sessions (for dashboard).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalTokenStats {
    pub total_tokens_in: u64,
    pub total_tokens_out: u64,
    pub total_tokens_cached: u64,
    pub total_tokens_truncated: u64,
    pub total_tokens_in_cache_write: u64,
    /// Provider-reported cost (null when no provider reported cost).
    pub total_actual_cost_cents: Option<u64>,
    pub total_cost_cents: u64,
    pub total_cost_unavailable: bool,
    pub total_calls: u64,
    pub total_sessions: u64,
    pub active_sessions: u64,
    pub avg_duration_ms: f64,
    pub success_rate: f64,
    pub truncation_rate: f64,
    pub cost_estimate_usd: String,
    pub baseline_method: String,
    pub suggestion: String,
}

impl GlobalTokenStats {
    /// Format cents as USD string (avoids float precision bugs).
    /// Returns "$X.XX" format (with dollar sign).
    pub fn cents_to_usd(cents: u64) -> String {
        format!("${:.2}", cents as f64 / 100.0)
    }
}
#[cfg(test)]
mod tests {
    
    use crate::config::AppSettings;

    #[test]
    fn test_app_settings_alert_threshold_defaults() {
        let settings = AppSettings::default();
        assert_eq!(settings.alert_runaway_session_cents, 500);
        assert!((settings.alert_cost_spike_multiplier - 5.0).abs() < 1e-6);
        assert!((settings.alert_abnormal_retry_rate - 0.30).abs() < 1e-6);
        assert_eq!(settings.alert_daily_cost_spike_cents, 1000);
    }
}
