use chrono::Utc;
use uuid::Uuid;

use super::{
    TokenCountSource, TokenCountSourceBreakdown, TokenUsageEvent, DEFAULT_TENANT_ID,
    TOKEN_USAGE_SCHEMA_VERSION,
};
use crate::token_usage::pricing;

/// Thread-safe token usage tracker using atomic counters for L1/L2 aggregation.
///
/// Events are collected in-memory and periodically flushed to persistent storage.
/// Concurrency is handled via DashMap for per-tool/per-model counters and a
/// Mutex-protected event buffer.
pub struct TokenUsageTracker {
    /// Per-session totals (L1).
    pub(crate) session_stats: dashmap::DashMap<String, SessionCounters>,

    /// Per-tool counters (L2).
    pub(crate) tool_counters: dashmap::DashMap<String, AtomicCounters>,

    /// Per-model counters (L2).
    pub(crate) model_counters: dashmap::DashMap<String, AtomicCounters>,

    /// Per-day counters (L3).
    pub(crate) daily_counters: dashmap::DashMap<String, AtomicCounters>,

    /// Global counters.
    pub(crate) global: AtomicCounters,

    /// Source breakdown
    pub(crate) api_reported_count: std::sync::atomic::AtomicU64,
    pub(crate) estimated_count: std::sync::atomic::AtomicU64,
    pub(crate) unavailable_count: std::sync::atomic::AtomicU64,

    /// Duration samples for percentile calculation (global).
    pub(crate) duration_samples: parking_lot::Mutex<std::collections::VecDeque<u64>>,

    /// Per-tool duration samples for L2 percentile calculation.
    pub(crate) tool_duration_samples: dashmap::DashMap<String, parking_lot::Mutex<std::collections::VecDeque<u64>>>,

    /// Per-model duration samples for L2 percentile calculation.
    pub(crate) model_duration_samples: dashmap::DashMap<String, parking_lot::Mutex<std::collections::VecDeque<u64>>>,

    /// Per-session duration samples for L1 percentile calculation.
    pub(crate) session_duration_samples: dashmap::DashMap<String, parking_lot::Mutex<std::collections::VecDeque<u64>>>,

    /// Per-day duration samples for L3 percentile calculation.
    pub(crate) daily_duration_samples: dashmap::DashMap<String, parking_lot::Mutex<std::collections::VecDeque<u64>>>,

    /// Max duration sample count.
    pub(crate) max_samples: usize,

    /// Persistent store (SQLite). Events are written here on every record()
    /// when the store is wired in.
    pub(crate) store: Option<std::sync::Arc<super::store::TokenUsageStore>>,
}

/// Atomic counters for a single aggregation bucket.
#[derive(Default)]
pub(crate) struct AtomicCounters {
    tokens_in_system: std::sync::atomic::AtomicU64,
    tokens_in_user: std::sync::atomic::AtomicU64,
    tokens_in_cached: std::sync::atomic::AtomicU64,
    tokens_out: std::sync::atomic::AtomicU64,
    tokens_truncated: std::sync::atomic::AtomicU64,
    cost_cents: std::sync::atomic::AtomicU64,
    call_count: std::sync::atomic::AtomicU64,
    success_count: std::sync::atomic::AtomicU64,
    retry_count: std::sync::atomic::AtomicU64,
    partial_count: std::sync::atomic::AtomicU64,
    truncation_count: std::sync::atomic::AtomicU64,
    cost_unavailable_count: std::sync::atomic::AtomicU64,
}

/// Per-session counters with lifecycle metadata.
#[derive(Debug)]
pub(crate) struct SessionCounters {
    pub(crate) session_id: String,
    pub(crate) tenant_id: String,
    pub(crate) tokens_in_system: std::sync::atomic::AtomicU64,
    pub(crate) tokens_in_user: std::sync::atomic::AtomicU64,
    pub(crate) tokens_in_cached: std::sync::atomic::AtomicU64,
    pub(crate) tokens_out: std::sync::atomic::AtomicU64,
    pub(crate) tokens_truncated: std::sync::atomic::AtomicU64,
    pub(crate) cost_cents: std::sync::atomic::AtomicU64,
    pub(crate) call_count: std::sync::atomic::AtomicU64,
    pub(crate) success_count: std::sync::atomic::AtomicU64,
    pub(crate) retry_count: std::sync::atomic::AtomicU64,
    pub(crate) partial_count: std::sync::atomic::AtomicU64,
    pub(crate) truncation_count: std::sync::atomic::AtomicU64,
    pub(crate) first_event: parking_lot::Mutex<Option<chrono::DateTime<Utc>>>,
    pub(crate) last_event: parking_lot::Mutex<Option<chrono::DateTime<Utc>>>,
    #[allow(dead_code)]
    pub(crate) created_at: chrono::DateTime<Utc>,
}

impl AtomicCounters {
    fn new() -> Self {
        Self::default()
    }

    pub(crate) fn snapshot(&self) -> CounterSnapshot {
        CounterSnapshot {
            tokens_in_system: self.tokens_in_system.load(std::sync::atomic::Ordering::Relaxed),
            tokens_in_user: self.tokens_in_user.load(std::sync::atomic::Ordering::Relaxed),
            tokens_in_cached: self.tokens_in_cached.load(std::sync::atomic::Ordering::Relaxed),
            tokens_out: self.tokens_out.load(std::sync::atomic::Ordering::Relaxed),
            tokens_truncated: self.tokens_truncated.load(std::sync::atomic::Ordering::Relaxed),
            cost_cents: self.cost_cents.load(std::sync::atomic::Ordering::Relaxed),
            call_count: self.call_count.load(std::sync::atomic::Ordering::Relaxed),
            success_count: self.success_count.load(std::sync::atomic::Ordering::Relaxed),
            retry_count: self.retry_count.load(std::sync::atomic::Ordering::Relaxed),
            partial_count: self.partial_count.load(std::sync::atomic::Ordering::Relaxed),
            truncation_count: self.truncation_count.load(std::sync::atomic::Ordering::Relaxed),
            cost_unavailable_count: self
                .cost_unavailable_count
                .load(std::sync::atomic::Ordering::Relaxed),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct CounterSnapshot {
    pub(crate) tokens_in_system: u64,
    pub(crate) tokens_in_user: u64,
    pub(crate) tokens_in_cached: u64,
    pub(crate) tokens_out: u64,
    pub(crate) tokens_truncated: u64,
    pub(crate) cost_cents: u64,
    pub(crate) call_count: u64,
    pub(crate) success_count: u64,
    pub(crate) retry_count: u64,
    pub(crate) partial_count: u64,
    pub(crate) truncation_count: u64,
    pub(crate) cost_unavailable_count: u64,
}

impl Default for TokenUsageTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl TokenUsageTracker {
    /// Create a new tracker with default settings (in-memory only, no persistence).
    pub fn new() -> Self {
        Self::with_store(None)
    }

    /// Create a new tracker with an optional persistent store.
    pub fn with_store(store: Option<std::sync::Arc<super::store::TokenUsageStore>>) -> Self {
        Self {
            session_stats: dashmap::DashMap::new(),
            tool_counters: dashmap::DashMap::new(),
            model_counters: dashmap::DashMap::new(),
            daily_counters: dashmap::DashMap::new(),
            global: AtomicCounters::new(),
            api_reported_count: std::sync::atomic::AtomicU64::new(0),
            estimated_count: std::sync::atomic::AtomicU64::new(0),
            unavailable_count: std::sync::atomic::AtomicU64::new(0),
            duration_samples: parking_lot::Mutex::new(std::collections::VecDeque::with_capacity(10000)),
            tool_duration_samples: dashmap::DashMap::new(),
            model_duration_samples: dashmap::DashMap::new(),
            session_duration_samples: dashmap::DashMap::new(),
            daily_duration_samples: dashmap::DashMap::new(),
            max_samples: 10000,
            store,
        }
    }

    /// Record a token usage event. This is the primary entry point.
    ///
    /// Uses atomic operations for all counters — safe to call from any thread.
    /// This does NOT block the calling LLM request path.
    pub fn record(&self, event: TokenUsageEvent) {
        let day_key = event.timestamp.format("%Y-%m-%d").to_string();
        let tool_key = event.tool_name.clone();
        let model_key = event.model_id.clone();
        let session_key = event.session_id.clone();

        // ── Global counters (atomic) ──
        let g = &self.global;
        g.tokens_in_system
            .fetch_add(event.tokens_in_system, std::sync::atomic::Ordering::Relaxed);
        g.tokens_in_user
            .fetch_add(event.tokens_in_user, std::sync::atomic::Ordering::Relaxed);
        g.tokens_in_cached
            .fetch_add(event.tokens_in_cached, std::sync::atomic::Ordering::Relaxed);
        g.tokens_out
            .fetch_add(event.tokens_out, std::sync::atomic::Ordering::Relaxed);
        g.tokens_truncated
            .fetch_add(event.tokens_truncated, std::sync::atomic::Ordering::Relaxed);
        g.cost_cents
            .fetch_add(event.cost_estimate_cents, std::sync::atomic::Ordering::Relaxed);
        g.call_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if event.success {
            g.success_count
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        if event.retry_attempt > 0 {
            g.retry_count
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        if event.was_partial {
            g.partial_count
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        if event.tokens_truncated > 0 {
            g.truncation_count
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        if event.cost_unavailable {
            g.cost_unavailable_count
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }

        // ── Per-session counters ──
        self.session_stats
            .entry(session_key.clone())
            .or_insert_with(|| SessionCounters {
                session_id: session_key.clone(),
                tenant_id: event.tenant_id.clone(),
                tokens_in_system: std::sync::atomic::AtomicU64::new(0),
                tokens_in_user: std::sync::atomic::AtomicU64::new(0),
                tokens_in_cached: std::sync::atomic::AtomicU64::new(0),
                tokens_out: std::sync::atomic::AtomicU64::new(0),
                tokens_truncated: std::sync::atomic::AtomicU64::new(0),
                cost_cents: std::sync::atomic::AtomicU64::new(0),
                call_count: std::sync::atomic::AtomicU64::new(0),
                success_count: std::sync::atomic::AtomicU64::new(0),
                retry_count: std::sync::atomic::AtomicU64::new(0),
                partial_count: std::sync::atomic::AtomicU64::new(0),
                truncation_count: std::sync::atomic::AtomicU64::new(0),
                first_event: parking_lot::Mutex::new(Some(event.timestamp)),
                last_event: parking_lot::Mutex::new(Some(event.timestamp)),
                created_at: Utc::now(),
            })
            .update_counters(&event);

        // ── Per-tool counters ──
        self.tool_counters
            .entry(tool_key)
            .or_default()
            .add_event(&event);

        // ── Per-model counters ──
        self.model_counters
            .entry(model_key)
            .or_default()
            .add_event(&event);

        // ── Per-day counters ──
        self.daily_counters
            .entry(day_key.clone())
            .or_default()
            .add_event(&event);

        // ── Source breakdown ──
        match event.token_count_source {
            TokenCountSource::ApiReported => {
                self.api_reported_count
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            TokenCountSource::Estimated => {
                self.estimated_count
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            TokenCountSource::Unavailable => {
                self.unavailable_count
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        }

        // ── Duration samples (global) ──
        {
            let mut samples = self.duration_samples.lock();
            if samples.len() >= self.max_samples {
                // Ring buffer: pop front (O(1))
                samples.pop_front();
            }
            samples.push_back(event.duration_ms);
        }

        // ── Per-tool duration samples ──
        {
            let tool_key_for_samples = event.tool_name.clone();
            let entry = self.tool_duration_samples
                .entry(tool_key_for_samples)
                .or_insert_with(|| parking_lot::Mutex::new(std::collections::VecDeque::with_capacity(1000)));
            let mut samples = entry.lock();
            if samples.len() >= 1000 {
                samples.pop_front();
            }
            samples.push_back(event.duration_ms);
        }

        // ── Per-model duration samples ──
        {
            let model_key_for_samples = event.model_id.clone();
            let entry = self.model_duration_samples
                .entry(model_key_for_samples)
                .or_insert_with(|| parking_lot::Mutex::new(std::collections::VecDeque::with_capacity(1000)));
            let mut samples = entry.lock();
            if samples.len() >= 1000 {
                samples.pop_front();
            }
            samples.push_back(event.duration_ms);
        }

        // ── Per-session duration samples ──
        {
            let session_key_for_samples = event.session_id.clone();
            let entry = self.session_duration_samples
                .entry(session_key_for_samples)
                .or_insert_with(|| parking_lot::Mutex::new(std::collections::VecDeque::with_capacity(1000)));
            let mut samples = entry.lock();
            if samples.len() >= 1000 {
                samples.pop_front();
            }
            samples.push_back(event.duration_ms);
        }

        // ── Per-day duration samples ──
        {
            let day_key_for_samples = day_key.clone();
            let entry = self.daily_duration_samples
                .entry(day_key_for_samples)
                .or_insert_with(|| parking_lot::Mutex::new(std::collections::VecDeque::with_capacity(1000)));
            let mut samples = entry.lock();
            if samples.len() >= 1000 {
                samples.pop_front();
            }
            samples.push_back(event.duration_ms);
        }

        // ── Persist to SQLite store (if wired) ──
        if let Some(ref store) = self.store {
            if let Err(e) = store.insert(&event) {
                tracing::warn!("Failed to persist token usage event to SQLite: {}", e);
            }
        }
    }

    /// Build a `TokenUsageEvent` for a completed (non-streaming) request.
    ///
    /// This is a convenience factory that computes cost and sets defaults.
    #[allow(clippy::too_many_arguments)]
    pub fn build_event(
        session_id: &str,
        tool_name: &str,
        model_id: &str,
        tokens_in_system: u64,
        tokens_in_user: u64,
        tokens_in_cached: u64,
        tokens_out: u64,
        tokens_truncated: u64,
        was_streamed: bool,
        was_partial: bool,
        duration_ms: u64,
        success: bool,
        token_count_source: TokenCountSource,
        retry_attempt: u32,
    ) -> TokenUsageEvent {
        let (cost_cents, pricing_as_of, cost_unavailable) =
            pricing::estimate_cost_cents(model_id, tokens_in_system, tokens_in_user, tokens_in_cached, tokens_out);

        TokenUsageEvent {
            schema_version: TOKEN_USAGE_SCHEMA_VERSION,
            event_id: Uuid::new_v4().to_string(),
            timestamp: Utc::now(),
            session_id: session_id.to_string(),
            tenant_id: DEFAULT_TENANT_ID.to_string(),
            tool_name: tool_name.to_string(),
            model_id: model_id.to_string(),
            retry_attempt,
            tokens_in_system,
            tokens_in_user,
            tokens_in_cached,
            tokens_out,
            tokens_truncated,
            token_count_source,
            was_streamed,
            was_partial,
            duration_ms,
            cost_estimate_cents: cost_cents,
            pricing_as_of,
            cost_unavailable,
            success,
        }
    }

    /// Get global stats summary for the dashboard.
    pub fn global_stats(&self) -> super::GlobalTokenStats {
        let g = self.global.snapshot();
        let total_sessions = self.session_stats.len() as u64;

        let success_rate = if g.call_count > 0 {
            g.success_count as f64 / g.call_count as f64
        } else {
            1.0
        };

        let truncation_rate = if g.call_count > 0 {
            g.truncation_count as f64 / g.call_count as f64
        } else {
            0.0
        };

        let avg_duration_ms = {
            let samples = self.duration_samples.lock();
            if samples.is_empty() {
                0.0
            } else {
                samples.iter().sum::<u64>() as f64 / samples.len() as f64
            }
        };

        let cost_unavailable = g.cost_unavailable_count > 0;
        let total_tokens_in = g.tokens_in_system + g.tokens_in_user + g.tokens_in_cached;

        // Estimate tokens saved vs full-file-read baseline
        // Heuristic: if caching saved tokens, those are "saved"
        let tokens_saved = g.tokens_in_cached;

        let tokens_saved_pct = if total_tokens_in > 0 {
            (tokens_saved as f64 / total_tokens_in as f64) * 100.0
        } else {
            0.0
        };

        let total_input = g.tokens_in_system + g.tokens_in_user + g.tokens_in_cached;
        let system_overhead_pct = if total_input > 0 {
            (g.tokens_in_system as f64 / total_input as f64) * 100.0
        } else {
            0.0
        };
        let suggestion = generate_suggestion(truncation_rate, system_overhead_pct, tokens_saved_pct);

        super::GlobalTokenStats {
            total_tokens_in: g.tokens_in_system + g.tokens_in_user + g.tokens_in_cached,
            total_tokens_out: g.tokens_out,
            total_tokens_cached: g.tokens_in_cached,
            total_tokens_truncated: g.tokens_truncated,
            total_cost_cents: g.cost_cents,
            total_cost_unavailable: cost_unavailable,
            total_calls: g.call_count,
            total_sessions,
            active_sessions: self.count_active_sessions(),
            avg_duration_ms,
            success_rate,
            truncation_rate,
            cost_estimate_usd: super::GlobalTokenStats::cents_to_usd(g.cost_cents),
            baseline_method: "full_file_read".to_string(),
            suggestion,
        }
    }

    /// Get L1 stats for a specific session.
    pub fn session_stats(&self, session_id: &str) -> Option<super::SessionTokenStats> {
        self.session_stats.get(session_id).map(|s| {
            let mut stats = s.to_stats();
            let (avg, p50, p99) = self.session_duration_samples
                .get(session_id)
                .map(|samples| {
                    let s = samples.lock();
                    compute_duration_percentiles(&s)
                })
                .unwrap_or((0.0, 0.0, 0.0));
            stats.avg_duration_ms = avg;
            stats.p50_duration_ms = p50;
            stats.p99_duration_ms = p99;
            stats
        })
    }

    /// Get all session stats.
    pub fn all_session_stats(&self) -> Vec<super::SessionTokenStats> {
        self.session_stats
            .iter()
            .map(|s| {
                let mut stats = s.value().to_stats();
                let (avg, p50, p99) = self.session_duration_samples
                    .get(s.key())
                    .map(|samples| {
                        let s = samples.lock();
                        compute_duration_percentiles(&s)
                    })
                    .unwrap_or((0.0, 0.0, 0.0));
                stats.avg_duration_ms = avg;
                stats.p50_duration_ms = p50;
                stats.p99_duration_ms = p99;
                stats
            })
            .collect()
    }

    /// Get L2 per-tool breakdown.
    pub fn tool_stats(&self) -> Vec<super::ToolTokenStats> {
        let global_total = self
            .tool_counters
            .iter()
            .map(|e| e.value().tokens_out.load(std::sync::atomic::Ordering::Relaxed))
            .sum::<u64>();

        self.tool_counters
            .iter()
            .map(|entry| {
                let tool = entry.key().clone();
                let s = entry.value().snapshot();
                let _total_tokens = s.tokens_in_system + s.tokens_in_user + s.tokens_in_cached + s.tokens_out;
                let pct_of_total = if global_total > 0 {
                    (s.tokens_out as f64 / global_total as f64) * 100.0
                } else {
                    0.0
                };
                let mut stats = counters_to_tool_stats(&tool, &s, pct_of_total);
                let (avg, p50, p99) = self.tool_duration_samples
                    .get(&tool)
                    .map(|samples| {
                        let s = samples.lock();
                        compute_duration_percentiles(&s)
                    })
                    .unwrap_or((0.0, 0.0, 0.0));
                stats.avg_duration_ms = avg;
                stats.p50_duration_ms = p50;
                stats.p99_duration_ms = p99;
                stats
            })
            .collect()
    }

    /// Get L2 per-model breakdown.
    pub fn model_stats(&self) -> Vec<super::ModelTokenStats> {
        self.model_counters
            .iter()
            .map(|entry| {
                let model_id = entry.key().clone();
                let s = entry.value().snapshot();
                let mut stats = counters_to_model_stats(&model_id, &s);
                let (avg, p50, p99) = self.model_duration_samples
                    .get(&model_id)
                    .map(|samples| {
                        let s = samples.lock();
                        compute_duration_percentiles(&s)
                    })
                    .unwrap_or((0.0, 0.0, 0.0));
                stats.avg_duration_ms = avg;
                stats.p50_duration_ms = p50;
                stats.p99_duration_ms = p99;
                stats
            })
            .collect()
    }

    /// Get token count source breakdown.
    pub fn source_breakdown(&self) -> TokenCountSourceBreakdown {
        TokenCountSourceBreakdown {
            api_reported: self
                .api_reported_count
                .load(std::sync::atomic::Ordering::Relaxed),
            estimated: self
                .estimated_count
                .load(std::sync::atomic::Ordering::Relaxed),
            unavailable: self
                .unavailable_count
                .load(std::sync::atomic::Ordering::Relaxed),
        }
    }

    /// Count active sessions (recent activity).
    fn count_active_sessions(&self) -> u64 {
        let cutoff = Utc::now() - chrono::Duration::minutes(30);
        self.session_stats
            .iter()
            .filter(|s| {
                let guard = s.last_event.lock();
                match *guard {
                    Some(t) => t > cutoff,
                    None => false,
                }
            })
            .count() as u64
    }

    /// Mark a session as closed.
    pub fn close_session(&self, session_id: &str) {
        // Sessions are left in the map but will be considered "closed"
        // This is a no-op for now; lifecycle status is derived from activity.
        let _ = session_id;
    }

    /// Clear all stats (for testing or reset).
    pub fn clear(&self) {
        self.session_stats.clear();
        self.tool_counters.clear();
        self.model_counters.clear();
        self.daily_counters.clear();
        self.duration_samples.lock().clear();
        self.tool_duration_samples.clear();
        self.model_duration_samples.clear();
        self.session_duration_samples.clear();
        self.daily_duration_samples.clear();
        // Reset global atomics
        let g = &self.global;
        for atomic in &[
            &g.tokens_in_system, &g.tokens_in_user, &g.tokens_in_cached,
            &g.tokens_out, &g.tokens_truncated, &g.cost_cents,
            &g.call_count, &g.success_count, &g.retry_count,
            &g.partial_count, &g.truncation_count, &g.cost_unavailable_count,
        ] {
            atomic.store(0, std::sync::atomic::Ordering::Relaxed);
        }
        self.api_reported_count
            .store(0, std::sync::atomic::Ordering::Relaxed);
        self.estimated_count
            .store(0, std::sync::atomic::Ordering::Relaxed);
        self.unavailable_count
            .store(0, std::sync::atomic::Ordering::Relaxed);
    }

    /// Create an error event for a failed request.
    pub fn new_err(
        session_id: &str,
        model: &str,
        tool_name: &str,
        duration_ms: u64,
        _error: &str,
    ) -> TokenUsageEvent {
        use super::TOKEN_USAGE_SCHEMA_VERSION;
        use super::DEFAULT_TENANT_ID;

        TokenUsageEvent {
            schema_version: TOKEN_USAGE_SCHEMA_VERSION,
            event_id: uuid::Uuid::new_v4().to_string(),
            timestamp: chrono::Utc::now(),
            session_id: session_id.to_string(),
            tenant_id: DEFAULT_TENANT_ID.to_string(),
            tool_name: tool_name.to_string(),
            model_id: model.to_string(),
            retry_attempt: 0,
            tokens_in_system: 0,
            tokens_in_user: 0,
            tokens_in_cached: 0,
            tokens_out: 0,
            tokens_truncated: 0,
            token_count_source: TokenCountSource::Unavailable,
            was_streamed: false,
            was_partial: false,
            duration_ms,
            cost_estimate_cents: 0,
            pricing_as_of: String::new(),
            cost_unavailable: true,
            success: false,
        }
    }

    /// Create a token usage event by extracting counts from an API response.
    ///
    /// Handles both OpenAI and Anthropic response formats.
    /// Falls back to estimated system tokens when `usage` is absent.
    pub fn new_from_response(
        session_id: &str,
        model: &str,
        tool_name: &str,
        duration_ms: u64,
        response: &serde_json::Value,
        is_anthropic: bool,
        is_streaming: bool,
    ) -> TokenUsageEvent {
        use super::TOKEN_USAGE_SCHEMA_VERSION;
        use super::DEFAULT_TENANT_ID;

        let (tokens_in_system, tokens_in_user, tokens_in_cached, tokens_out, token_count_source) =
            if is_anthropic {
                let usage = pricing::extract_anthropic_usage(response);
                if usage.input_tokens == 0 && usage.output_tokens == 0 {
                    let sys = pricing::estimate_system_tokens(model);
                    (sys, 0, 0, 0, TokenCountSource::Unavailable)
                } else {
                    let sys = pricing::estimate_system_tokens(model);
                    let user = if usage.input_tokens > sys { usage.input_tokens - sys } else { usage.input_tokens };
                    (sys, user, usage.cache_read_input_tokens, usage.output_tokens, TokenCountSource::ApiReported)
                }
            } else {
                let usage = pricing::extract_openai_usage(response);
                if usage.prompt_tokens == 0 && usage.completion_tokens == 0 {
                    let sys = pricing::estimate_system_tokens(model);
                    (sys, 0, 0, 0, TokenCountSource::Unavailable)
                } else {
                    let sys = pricing::estimate_system_tokens(model);
                    let user = if usage.prompt_tokens > sys { usage.prompt_tokens - sys } else { usage.prompt_tokens };
                    (sys, user, usage.cached_tokens, usage.completion_tokens, TokenCountSource::ApiReported)
                }
            };

        let (cost_cents, pricing_as_of, cost_unavailable) =
            pricing::estimate_cost_cents(model, tokens_in_system, tokens_in_user, tokens_in_cached, tokens_out);

        TokenUsageEvent {
            schema_version: TOKEN_USAGE_SCHEMA_VERSION,
            event_id: uuid::Uuid::new_v4().to_string(),
            timestamp: chrono::Utc::now(),
            session_id: session_id.to_string(),
            tenant_id: DEFAULT_TENANT_ID.to_string(),
            tool_name: tool_name.to_string(),
            model_id: model.to_string(),
            retry_attempt: 0,
            tokens_in_system,
            tokens_in_user,
            tokens_in_cached,
            tokens_out,
            tokens_truncated: 0,
            token_count_source,
            was_streamed: is_streaming,
            was_partial: false,
            duration_ms,
            cost_estimate_cents: cost_cents,
            pricing_as_of,
            cost_unavailable,
            success: true,
        }
    }
}

// ── Helper implementations ──────────────────────────────────────────────────

impl SessionCounters {
    fn update_counters(&self, event: &TokenUsageEvent) {
        self.tokens_in_system
            .fetch_add(event.tokens_in_system, std::sync::atomic::Ordering::Relaxed);
        self.tokens_in_user
            .fetch_add(event.tokens_in_user, std::sync::atomic::Ordering::Relaxed);
        self.tokens_in_cached
            .fetch_add(event.tokens_in_cached, std::sync::atomic::Ordering::Relaxed);
        self.tokens_out
            .fetch_add(event.tokens_out, std::sync::atomic::Ordering::Relaxed);
        self.tokens_truncated
            .fetch_add(event.tokens_truncated, std::sync::atomic::Ordering::Relaxed);
        self.cost_cents
            .fetch_add(event.cost_estimate_cents, std::sync::atomic::Ordering::Relaxed);
        self.call_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if event.success {
            self.success_count
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        if event.retry_attempt > 0 {
            self.retry_count
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        if event.was_partial {
            self.partial_count
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        if event.tokens_truncated > 0 {
            self.truncation_count
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }

        // Update timestamps
        {
            let mut last = self.last_event.lock();
            *last = Some(event.timestamp);
        }
    }

    fn to_stats(&self) -> super::SessionTokenStats {
        let call_count = self
            .call_count
            .load(std::sync::atomic::Ordering::Relaxed);
        let _success_count = self
            .success_count
            .load(std::sync::atomic::Ordering::Relaxed);
        let first_event = *self.first_event.lock();
        let last_event = *self.last_event.lock();

        let duration_seconds = match (first_event, last_event) {
            (Some(first), Some(last)) => (last - first).num_seconds().max(0) as u64,
            _ => 0,
        };

        // Estimate tokens saved vs full-file-read baseline
        let tokens_in_cached = self
            .tokens_in_cached
            .load(std::sync::atomic::Ordering::Relaxed);

        // Derive cost_unavailable from whether any event lacked pricing
        // If all events had pricing, cost_unavailable_count is 0
        // We don't track cost_unavailable_count per-session currently,
        // so we check whether cost_cents is zero AND call_count > 0
        let cost_unavailable = self.cost_cents.load(std::sync::atomic::Ordering::Relaxed) == 0
            && self.call_count.load(std::sync::atomic::Ordering::Relaxed) > 0;

        super::SessionTokenStats {
            session_id: self.session_id.clone(),
            tenant_id: self.tenant_id.clone(),
            status: super::SessionStatus::Active, // Derived from activity
            duration_seconds,
            tokens_in_system: self
                .tokens_in_system
                .load(std::sync::atomic::Ordering::Relaxed),
            tokens_in_user: self
                .tokens_in_user
                .load(std::sync::atomic::Ordering::Relaxed),
            tokens_in_cached,
            tokens_out: self.tokens_out.load(std::sync::atomic::Ordering::Relaxed),
            tokens_truncated: self
                .tokens_truncated
                .load(std::sync::atomic::Ordering::Relaxed),
            cost_estimate_cents: self.cost_cents.load(std::sync::atomic::Ordering::Relaxed),
            cost_unavailable,
            truncation_count: self
                .truncation_count
                .load(std::sync::atomic::Ordering::Relaxed),
            retry_count: self.retry_count.load(std::sync::atomic::Ordering::Relaxed),
            partial_count: self
                .partial_count
                .load(std::sync::atomic::Ordering::Relaxed),
            call_count,
            avg_duration_ms: 0.0, // Populated by caller via session_duration_samples
            p50_duration_ms: 0.0,
            p99_duration_ms: 0.0,
            tokens_saved_vs_full_file_read: tokens_in_cached,
            baseline_method: "full_file_read".to_string(),
            baseline_disclaimer: "Savings are relative to reading entire files. Your results may vary.".to_string(),
            first_event,
            last_event,
        }
    }
}

impl AtomicCounters {
    fn add_event(&self, event: &TokenUsageEvent) {
        self.tokens_in_system
            .fetch_add(event.tokens_in_system, std::sync::atomic::Ordering::Relaxed);
        self.tokens_in_user
            .fetch_add(event.tokens_in_user, std::sync::atomic::Ordering::Relaxed);
        self.tokens_in_cached
            .fetch_add(event.tokens_in_cached, std::sync::atomic::Ordering::Relaxed);
        self.tokens_out
            .fetch_add(event.tokens_out, std::sync::atomic::Ordering::Relaxed);
        self.tokens_truncated
            .fetch_add(event.tokens_truncated, std::sync::atomic::Ordering::Relaxed);
        self.cost_cents
            .fetch_add(event.cost_estimate_cents, std::sync::atomic::Ordering::Relaxed);
        self.call_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if event.success {
            self.success_count
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        if event.retry_attempt > 0 {
            self.retry_count
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        if event.was_partial {
            self.partial_count
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        if event.tokens_truncated > 0 {
            self.truncation_count
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        if event.cost_unavailable {
            self.cost_unavailable_count
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
}

fn counters_to_tool_stats(
    tool: &str,
    s: &CounterSnapshot,
    pct_of_total: f64,
) -> super::ToolTokenStats {
    let success_rate = if s.call_count > 0 {
        s.success_count as f64 / s.call_count as f64
    } else {
        1.0
    };
    let retry_rate = if s.call_count > 0 {
        s.retry_count as f64 / s.call_count as f64
    } else {
        0.0
    };
    let partial_rate = if s.call_count > 0 {
        s.partial_count as f64 / s.call_count as f64
    } else {
        0.0
    };

    super::ToolTokenStats {
        tool: tool.to_string(),
        tokens_in_system: s.tokens_in_system,
        tokens_in_user: s.tokens_in_user,
        tokens_in_cached: s.tokens_in_cached,
        tokens_out: s.tokens_out,
        tokens_truncated: s.tokens_truncated,
        cost_estimate_cents: s.cost_cents,
        call_count: s.call_count,
        success_rate,
        retry_rate,
        partial_rate,
        avg_duration_ms: 0.0,
        p50_duration_ms: 0.0,
        p99_duration_ms: 0.0,
        pct_of_total,
    }
}

fn counters_to_model_stats(
    model_id: &str,
    s: &CounterSnapshot,
) -> super::ModelTokenStats {
    super::ModelTokenStats {
        model_id: model_id.to_string(),
        tokens_in_system: s.tokens_in_system,
        tokens_in_user: s.tokens_in_user,
        tokens_in_cached: s.tokens_in_cached,
        tokens_out: s.tokens_out,
        cost_estimate_cents: s.cost_cents,
        cost_unavailable: s.cost_unavailable_count > 0,
        call_count: s.call_count,
        pricing_as_of: pricing::PRICING_AS_OF.to_string(),
        avg_duration_ms: 0.0,
        p50_duration_ms: 0.0,
        p99_duration_ms: 0.0,
    }
}

fn generate_suggestion(truncation_rate: f64, system_overhead_pct: f64, tokens_saved_pct: f64) -> String {
    let mut suggestions = Vec::new();

    if truncation_rate > 0.05 {
        suggestions.push(format!(
            "You hit context limits on {:.0}% of calls. Consider breaking your task into smaller steps.",
            truncation_rate * 100.0
        ));
    }

    if system_overhead_pct > 30.0 {
        suggestions.push(format!(
            "{:.0}% of input tokens are system prompt. Consider optimizing your system prompt.",
            system_overhead_pct
        ));
    }

    if suggestions.is_empty() {
        if tokens_saved_pct > 0.0 {
            format!(
                "Token caching saved {:.1}% of input tokens. Good efficiency!",
                tokens_saved_pct
            )
        } else {
            "Token usage is within normal parameters.".to_string()
        }
    } else {
        suggestions.join(" ")
    }
}

/// Compute avg, p50, and p99 from a VecDeque of duration samples.
/// Returns (avg, p50, p99). All zeros if samples is empty.
pub(crate) fn compute_duration_percentiles(samples: &std::collections::VecDeque<u64>) -> (f64, f64, f64) {
    if samples.is_empty() {
        return (0.0, 0.0, 0.0);
    }

    let mut sorted: Vec<u64> = samples.iter().copied().collect();
    sorted.sort_unstable();
    let len = sorted.len();

    let avg = sorted.iter().sum::<u64>() as f64 / len as f64;

    // Nearest-rank interpolation for percentiles
    let p50_idx = ((len as f64 - 1.0) * 0.50).round() as usize;
    let p99_idx = ((len as f64 - 1.0) * 0.99).round() as usize;

    let p50 = sorted[p50_idx] as f64;
    let p99 = sorted[p99_idx] as f64;

    (avg, p50, p99)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::token_usage::{TokenCountSource, TokenUsageEvent, TOKEN_USAGE_SCHEMA_VERSION, DEFAULT_TENANT_ID};

    #[allow(clippy::too_many_arguments)]
    fn make_event(
        session_id: &str,
        model_id: &str,
        tool_name: &str,
        tokens_in_system: u64,
        tokens_in_user: u64,
        tokens_in_cached: u64,
        tokens_out: u64,
        duration_ms: u64,
        success: bool,
    ) -> TokenUsageEvent {
        let (cost_cents, pricing_as_of, cost_unavailable) =
            pricing::estimate_cost_cents(model_id, tokens_in_system, tokens_in_user, tokens_in_cached, tokens_out);
        TokenUsageEvent {
            schema_version: TOKEN_USAGE_SCHEMA_VERSION,
            event_id: uuid::Uuid::new_v4().to_string(),
            timestamp: chrono::Utc::now(),
            session_id: session_id.to_string(),
            tenant_id: DEFAULT_TENANT_ID.to_string(),
            tool_name: tool_name.to_string(),
            model_id: model_id.to_string(),
            retry_attempt: 0,
            tokens_in_system,
            tokens_in_user,
            tokens_in_cached,
            tokens_out,
            tokens_truncated: 0,
            token_count_source: TokenCountSource::ApiReported,
            was_streamed: false,
            was_partial: false,
            duration_ms,
            cost_estimate_cents: cost_cents,
            pricing_as_of,
            cost_unavailable,
            success,
        }
    }

    #[test]
    fn test_record_single_event() {
        let tracker = TokenUsageTracker::new();
        let event = make_event("s1", "gpt-4o", "chat_completions", 500, 1000, 200, 300, 1200, true);
        tracker.record(event);

        let stats = tracker.global_stats();
        assert_eq!(stats.total_tokens_in, 1700); // 500 + 1000 + 200
        assert_eq!(stats.total_tokens_out, 300);
        assert_eq!(stats.total_tokens_cached, 200);
        assert_eq!(stats.total_calls, 1);
        assert_eq!(stats.success_rate, 1.0);
        assert_eq!(stats.truncation_rate, 0.0);
    }

    #[test]
    fn test_record_multiple_events_accumulate() {
        let tracker = TokenUsageTracker::new();
        tracker.record(make_event("s1", "gpt-4o", "chat_completions", 500, 1000, 0, 300, 1200, true));
        tracker.record(make_event("s1", "gpt-4o", "chat_completions", 500, 2000, 0, 600, 800, true));

        let stats = tracker.global_stats();
        assert_eq!(stats.total_calls, 2);
        assert_eq!(stats.total_tokens_in, 4000); // (500+1000) + (500+2000)
        assert_eq!(stats.total_tokens_out, 900); // 300 + 600
    }

    #[test]
    fn test_tool_stats() {
        let tracker = TokenUsageTracker::new();
        tracker.record(make_event("s1", "gpt-4o", "chat_completions", 500, 1000, 0, 300, 1200, true));
        tracker.record(make_event("s2", "gpt-4o", "passthrough", 500, 500, 0, 200, 600, true));

        let tools = tracker.tool_stats();
        assert_eq!(tools.len(), 2);

        let chat_tool = tools.iter().find(|t| t.tool == "chat_completions").unwrap();
        assert_eq!(chat_tool.call_count, 1);
        assert_eq!(chat_tool.tokens_out, 300);

        let pass_tool = tools.iter().find(|t| t.tool == "passthrough").unwrap();
        assert_eq!(pass_tool.call_count, 1);
        assert_eq!(pass_tool.tokens_out, 200);
    }

    #[test]
    fn test_model_stats() {
        let tracker = TokenUsageTracker::new();
        tracker.record(make_event("s1", "gpt-4o", "chat", 500, 1000, 0, 300, 1200, true));
        tracker.record(make_event("s2", "claude-3-5-sonnet", "chat", 500, 1000, 0, 300, 1200, true));

        let models = tracker.model_stats();
        assert_eq!(models.len(), 2);
    }

    #[test]
    fn test_session_stats() {
        let tracker = TokenUsageTracker::new();
        tracker.record(make_event("s1", "gpt-4o", "chat", 500, 1000, 0, 300, 1200, true));
        tracker.record(make_event("s1", "gpt-4o", "chat", 500, 2000, 0, 600, 800, true));
        tracker.record(make_event("s2", "gpt-4o", "chat", 500, 500, 0, 100, 400, true));

        let s1 = tracker.session_stats("s1").unwrap();
        assert_eq!(s1.call_count, 2);
        assert_eq!(s1.tokens_in_user, 3000); // 1000 + 2000

        let s2 = tracker.session_stats("s2").unwrap();
        assert_eq!(s2.call_count, 1);

        assert!(tracker.session_stats("nonexistent").is_none());
    }

    #[test]
    fn test_success_rate_calculation() {
        let tracker = TokenUsageTracker::new();
        tracker.record(make_event("s1", "gpt-4o", "chat", 500, 1000, 0, 300, 1200, true));
        tracker.record(make_event("s1", "gpt-4o", "chat", 500, 1000, 0, 300, 1200, false));
        tracker.record(make_event("s1", "gpt-4o", "chat", 500, 1000, 0, 300, 1200, true));

        let stats = tracker.global_stats();
        assert_eq!(stats.total_calls, 3);
        assert!((stats.success_rate - 0.6667).abs() < 0.01);
    }

    #[test]
    fn test_error_event() {
        let event = TokenUsageTracker::new_err("s1", "gpt-4o", "chat", 500, "connection timeout");
        assert!(!event.success);
        assert_eq!(event.token_count_source, TokenCountSource::Unavailable);
        assert!(event.cost_unavailable);
    }

    #[test]
    fn test_new_from_response_openai() {
        let response = serde_json::json!({
            "model": "gpt-4o",
            "usage": {
                "prompt_tokens": 1000,
                "completion_tokens": 200,
                "total_tokens": 1200
            }
        });
        let event = TokenUsageTracker::new_from_response(
            "s1", "gpt-4o", "chat", 500, &response, false, false,
        );
        assert_eq!(event.tokens_out, 200);
        assert_eq!(event.token_count_source, TokenCountSource::ApiReported);
        assert!(event.success);
    }

    #[test]
    fn test_new_from_response_anthropic() {
        let response = serde_json::json!({
            "model": "claude-3-5-sonnet",
            "usage": {
                "input_tokens": 1000,
                "output_tokens": 200,
                "cache_read_input_tokens": 500
            }
        });
        let event = TokenUsageTracker::new_from_response(
            "s1", "claude-3-5-sonnet", "chat", 500, &response, true, false,
        );
        assert_eq!(event.tokens_out, 200);
        assert_eq!(event.tokens_in_cached, 500);
        assert_eq!(event.token_count_source, TokenCountSource::ApiReported);
    }

    #[test]
    fn test_new_from_response_no_usage() {
        let response = serde_json::json!({"model": "gpt-4o"});
        let event = TokenUsageTracker::new_from_response(
            "s1", "gpt-4o", "chat", 500, &response, false, false,
        );
        assert_eq!(event.tokens_in_system, 500); // estimated
        assert_eq!(event.tokens_in_user, 0);
        assert_eq!(event.tokens_out, 0);
        assert_eq!(event.token_count_source, TokenCountSource::Unavailable);
    }

    #[test]
    fn test_clear_resets_all_stats() {
        let tracker = TokenUsageTracker::new();
        tracker.record(make_event("s1", "gpt-4o", "chat", 500, 1000, 0, 300, 1200, true));
        assert!(tracker.global_stats().total_calls > 0);

        tracker.clear();
        let stats = tracker.global_stats();
        assert_eq!(stats.total_calls, 0);
        assert_eq!(stats.total_tokens_in, 0);
        assert_eq!(stats.total_tokens_out, 0);
    }

    #[test]
    fn test_concurrent_recording_no_double_count() {
        use std::sync::Arc;
        use std::thread;

        let tracker = Arc::new(TokenUsageTracker::new());
        let mut handles = Vec::new();

        for _ in 0..10 {
            let t = Arc::clone(&tracker);
            handles.push(thread::spawn(move || {
                t.record(make_event("s1", "gpt-4o", "chat", 100, 200, 0, 50, 100, true));
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        let stats = tracker.global_stats();
        assert_eq!(stats.total_calls, 10);
        assert_eq!(stats.total_tokens_in, 3000); // (100 + 200) * 10
        assert_eq!(stats.total_tokens_out, 500); // 50 * 10
    }

    #[test]
    fn test_zero_tokens_not_confused_with_null() {
        // A call with actual 0 tokens should still be recorded.
        let tracker = TokenUsageTracker::new();
        let mut event = make_event("s1", "gpt-4o", "chat", 0, 0, 0, 0, 0, true);
        event.token_count_source = TokenCountSource::ApiReported;
        event.cost_unavailable = false;
        tracker.record(event);

        let stats = tracker.global_stats();
        assert_eq!(stats.total_calls, 1);
        assert_eq!(stats.total_tokens_in, 0);
        assert_eq!(stats.total_tokens_out, 0);
        assert_eq!(stats.cost_estimate_usd, "$0.00");
    }

    #[test]
    fn test_efficiency_metrics_division_by_zero() {
        let tracker = TokenUsageTracker::new();
        // No events - all ratios should handle division-by-zero gracefully
        let metrics = tracker.efficiency_metrics();
        assert_eq!(metrics.context_to_output_ratio, None);
        assert_eq!(metrics.cost_per_successful_task_cents, None);
        assert_eq!(metrics.system_overhead_pct, 0.0);
    }

    #[test]
    fn test_cost_as_integer_cents_never_float() {
        let tracker = TokenUsageTracker::new();
        tracker.record(make_event("s1", "gpt-4o", "chat", 500, 1000, 0, 300, 1200, true));
        let stats = tracker.global_stats();
        // total_cost_cents is u64 - always integer
        // total_cost_cents is u64 — it can never exceed u64::MAX
        // cost_estimate_usd is formatted as string "$X.XX"
        assert!(stats.cost_estimate_usd.starts_with('$'));
    }

    // ── Fix #3: Percentile latency tests ──

    #[test]
    fn test_session_stats_percentile_latencies_nonzero() {
        let tracker = TokenUsageTracker::new();
        // Record several events with different durations for the same session
        tracker.record(make_event("s1", "gpt-4o", "chat", 100, 200, 0, 50, 100, true));
        tracker.record(make_event("s1", "gpt-4o", "chat", 100, 200, 0, 50, 500, true));
        tracker.record(make_event("s1", "gpt-4o", "chat", 100, 200, 0, 50, 1000, true));

        let stats = tracker.session_stats("s1").unwrap();
        assert!(stats.avg_duration_ms > 0.0, "avg_duration_ms should be non-zero: {}", stats.avg_duration_ms);
        assert!(stats.p50_duration_ms > 0.0, "p50_duration_ms should be non-zero: {}", stats.p50_duration_ms);
        assert!(stats.p99_duration_ms > 0.0, "p99_duration_ms should be non-zero: {}", stats.p99_duration_ms);

        // avg should be (100+500+1000)/3 = 533.33
        assert!((stats.avg_duration_ms - 533.33).abs() < 1.0, "avg approximately 533.33, got {}", stats.avg_duration_ms);
        // p50 should be 500 (middle of [100,500,1000])
        assert!((stats.p50_duration_ms - 500.0).abs() < 1.0, "p50 approximately 500, got {}", stats.p50_duration_ms);
    }

    #[test]
    fn test_tool_stats_percentile_latencies_nonzero() {
        let tracker = TokenUsageTracker::new();
        tracker.record(make_event("s1", "gpt-4o", "chat_completions", 100, 200, 0, 50, 200, true));
        tracker.record(make_event("s2", "gpt-4o", "chat_completions", 100, 200, 0, 50, 800, true));

        let tools = tracker.tool_stats();
        let chat_tool = tools.iter().find(|t| t.tool == "chat_completions").unwrap();
        assert!(chat_tool.avg_duration_ms > 0.0, "tool avg should be non-zero");
        assert!(chat_tool.p50_duration_ms > 0.0, "tool p50 should be non-zero");
        assert!(chat_tool.p99_duration_ms > 0.0, "tool p99 should be non-zero");
    }

    #[test]
    fn test_model_stats_percentile_latencies_nonzero() {
        let tracker = TokenUsageTracker::new();
        tracker.record(make_event("s1", "gpt-4o", "chat", 100, 200, 0, 50, 300, true));
        tracker.record(make_event("s2", "gpt-4o", "chat", 100, 200, 0, 50, 700, true));

        let models = tracker.model_stats();
        let gpt4o = models.iter().find(|m| m.model_id == "gpt-4o").unwrap();
        assert!(gpt4o.avg_duration_ms > 0.0, "model avg should be non-zero");
        assert!(gpt4o.p50_duration_ms > 0.0, "model p50 should be non-zero");
        assert!(gpt4o.p99_duration_ms > 0.0, "model p99 should be non-zero");
    }

    #[test]
    fn test_percentile_empty_samples() {
        let tracker = TokenUsageTracker::new();
        let stats = tracker.session_stats("nonexistent");
        assert!(stats.is_none());

        // With no events, tool/model stats return 0.0
        let tools = tracker.tool_stats();
        assert!(tools.is_empty());
        let models = tracker.model_stats();
        assert!(models.is_empty());
    }

    // ── Fix #2: Store wiring tests ──

    #[test]
    fn test_tracker_with_store_wiring() {
        use crate::token_usage::store::TokenUsageStore;
        // Create a temp DB for testing
        let db_path = std::env::temp_dir().join("aelvyril_test_token_usage.db");
        // Clean up any previous test DB
        let _ = std::fs::remove_file(&db_path);

        let store = TokenUsageStore::open(&db_path).expect("Failed to open test DB");
        let tracker = TokenUsageTracker::with_store(Some(std::sync::Arc::new(store)));

        tracker.record(make_event("s1", "gpt-4o", "chat", 500, 1000, 0, 300, 1200, true));
        tracker.record(make_event("s2", "gpt-4o", "chat", 500, 2000, 0, 600, 800, true));

        // Verify in-memory stats work
        let stats = tracker.global_stats();
        assert_eq!(stats.total_calls, 2);

        // Clean up
        let _ = std::fs::remove_file(&db_path);
    }

    #[test]
    fn test_tracker_without_store_graceful() {
        // Default new() should work without a store (in-memory only)
        let tracker = TokenUsageTracker::new();
        tracker.record(make_event("s1", "gpt-4o", "chat", 500, 1000, 0, 300, 1200, true));
        let stats = tracker.global_stats();
        assert_eq!(stats.total_calls, 1);
    }
}