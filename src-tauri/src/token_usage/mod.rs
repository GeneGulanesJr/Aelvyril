pub mod aggregator;
pub mod pricing;
pub mod store;
pub mod tracker;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Schema version for migration support. Bump on breaking changes.
pub const TOKEN_USAGE_SCHEMA_VERSION: u32 = 1;

/// Default tenant ID for single-tenant deployments.
pub const DEFAULT_TENANT_ID: &str = "default";

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
    /// Cost in integer cents (avoids float precision bugs).
    /// e.g., $0.42 → 42.
    pub cost_estimate_cents: u64,
    /// Date the pricing table was last verified.
    pub pricing_as_of: String,
    /// True if pricing data was missing for this model.
    pub cost_unavailable: bool,

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

    pub cost_estimate_cents: u64,
    pub cost_unavailable: bool,

    pub truncation_count: u64,
    pub retry_count: u64,
    pub partial_count: u64,
    pub call_count: u64,

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
    pub cost_estimate_cents: u64,
    pub call_count: u64,
    pub success_count: u64,
    pub retry_count: u64,
    pub partial_count: u64,
    pub avg_duration_ms: f64,
    pub truncation_rate: f64,
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
    pub token_count_reconciliation_issue: bool,
    pub incomplete_data: bool,
    pub orphaned: bool,
    pub access_level: String, // "full" | "summary" | "redacted"
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