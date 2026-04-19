use super::{
    DailyTokenTrend, EfficiencyMetrics,
    SessionTokenStats, SessionStatus, TokenStatsMeta,
    TokenStatsResponse, TOKEN_USAGE_SCHEMA_VERSION, DEFAULT_TENANT_ID,
};
use crate::token_usage::tracker::TokenUsageTracker;

impl TokenUsageTracker {
    /// Compute L4 efficiency metrics from current counters.
    pub fn efficiency_metrics(&self) -> EfficiencyMetrics {
        let g = self.global.snapshot();

        let context_to_output_ratio = if g.tokens_out > 0 {
            Some((g.tokens_in_user + g.tokens_in_cached) as f64 / g.tokens_out as f64)
        } else {
            None
        };

        let total_input = g.tokens_in_system + g.tokens_in_user + g.tokens_in_cached;
        let system_overhead_pct = if total_input > 0 {
            (g.tokens_in_system as f64 / total_input as f64) * 100.0
        } else {
            0.0
        };

        let cost_per_successful_task_cents = if g.success_count > 0 {
            Some(g.cost_cents / g.success_count)
        } else {
            None
        };

        let tokens_saved = g.tokens_in_cached;
        let tokens_saved_pct = if total_input > 0 {
            (tokens_saved as f64 / total_input as f64) * 100.0
        } else {
            0.0
        };

        let truncation_rate = if g.call_count > 0 {
            g.truncation_count as f64 / g.call_count as f64
        } else {
            0.0
        };

        let suggestion = self.build_suggestion(truncation_rate, system_overhead_pct, tokens_saved_pct);

        EfficiencyMetrics {
            context_to_output_ratio,
            system_overhead_pct,
            cost_per_successful_task_cents,
            tokens_saved_pct,
            baseline_method: "full_file_read".to_string(),
            baseline_disclaimer: "Savings are relative to reading entire files. Your results may vary.".to_string(),
            truncation_rate,
            suggestion,
        }
    }

    /// Build L3 daily trend data.
    pub fn daily_trends(&self) -> Vec<DailyTokenTrend> {
        self.daily_counters
            .iter()
            .map(|entry| {
                let date = entry.key().clone();
                let s = entry.value().snapshot();
                let truncation_rate = if s.call_count > 0 {
                    s.truncation_count as f64 / s.call_count as f64
                } else {
                    0.0
                };
                let avg_duration_ms = self.daily_duration_samples
                    .get(&date)
                    .map(|samples| {
                        let s = samples.lock();
                        crate::token_usage::tracker::compute_duration_percentiles(&s).0
                    })
                    .unwrap_or(0.0);
                DailyTokenTrend {
                    date,
                    tokens_in_system: s.tokens_in_system,
                    tokens_in_user: s.tokens_in_user,
                    tokens_in_cached: s.tokens_in_cached,
                    tokens_out: s.tokens_out,
                    tokens_truncated: s.tokens_truncated,
                    cost_estimate_cents: s.cost_cents,
                    call_count: s.call_count,
                    success_count: s.success_count,
                    retry_count: s.retry_count,
                    partial_count: s.partial_count,
                    avg_duration_ms,
                    truncation_rate,
                }
            })
            .collect()
    }

    /// Build the full stats response (matches Step 5 output format).
    pub fn full_stats(&self, session_id: Option<&str>) -> TokenStatsResponse {
        let session = match session_id {
            Some(id) => self
                .session_stats(id)
                .unwrap_or_else(|| default_session_stats(id)),
            None => self
                .all_session_stats()
                .into_iter()
                .next()
                .unwrap_or_else(|| default_session_stats("global")),
        };

        let by_tool = self.tool_stats();
        let by_model = self.model_stats();
        let daily_trends = self.daily_trends();
        let efficiency = self.efficiency_metrics();
        let source_breakdown = self.source_breakdown();

        let meta = TokenStatsMeta {
            schema_version: TOKEN_USAGE_SCHEMA_VERSION,
            token_count_sources: source_breakdown,
            token_count_reconciliation_issue: false,
            incomplete_data: false,
            orphaned: false,
            access_level: "full".to_string(),
        };

        TokenStatsResponse {
            session,
            by_tool,
            by_model,
            daily_trends,
            efficiency,
            meta,
        }
    }

    /// Build a contextual suggestion based on current stats.
    fn build_suggestion(
        &self,
        truncation_rate: f64,
        system_overhead_pct: f64,
        _tokens_saved_pct: f64,
    ) -> String {
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

        let g = self.global.snapshot();
        if g.tokens_in_cached > 0 && g.call_count > 0 {
            let total_input = g.tokens_in_system + g.tokens_in_user + g.tokens_in_cached;
            let cache_pct = (g.tokens_in_cached as f64 / total_input as f64) * 100.0;
            suggestions.push(format!(
                "{:.0}% of input tokens were served from cache, saving cost.",
                cache_pct
            ));
        }

        if suggestions.is_empty() {
            "Token usage is within normal parameters.".to_string()
        } else {
            suggestions.join(" ")
        }
    }
}

fn default_session_stats(id: &str) -> SessionTokenStats {
    SessionTokenStats {
        session_id: id.to_string(),
        tenant_id: DEFAULT_TENANT_ID.to_string(),
        status: SessionStatus::Active,
        duration_seconds: 0,
        tokens_in_system: 0,
        tokens_in_user: 0,
        tokens_in_cached: 0,
        tokens_out: 0,
        tokens_truncated: 0,
        cost_estimate_cents: 0,
        cost_unavailable: true,
        truncation_count: 0,
        retry_count: 0,
        partial_count: 0,
        call_count: 0,
        avg_duration_ms: 0.0,
        p50_duration_ms: 0.0,
        p99_duration_ms: 0.0,
        tokens_saved_vs_full_file_read: 0,
        baseline_method: "full_file_read".to_string(),
        baseline_disclaimer: "Savings are relative to reading entire files. Your results may vary.".to_string(),
        first_event: None,
        last_event: None,
    }
}