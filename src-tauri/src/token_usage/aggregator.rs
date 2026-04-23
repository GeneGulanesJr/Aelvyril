use super::{
    DailyTokenTrend, EfficiencyMetrics, SessionStatus, SessionTokenStats, TokenStatsMeta,
    TokenStatsResponse, DEFAULT_TENANT_ID, TOKEN_USAGE_SCHEMA_VERSION,
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

        // L4 intensity metrics: tokens and cost per active day
        let active_days = self.daily_counters.len() as u64;
        let tokens_per_active_day = if active_days > 0 {
            let total_tokens = g.tokens_in_system + g.tokens_in_user + g.tokens_in_cached + g.tokens_out;
            Some(total_tokens as f64 / active_days as f64)
        } else {
            None
        };
        let cost_per_active_day_cents = if active_days > 0 {
            Some(g.cost_cents / active_days)
        } else {
            None
        };

        // L4 quality score: composite of success rate, low retry, low truncation
        let quality_score = if g.call_count > 0 {
            let success_rate = g.success_count as f64 / g.call_count as f64;
            let retry_rate = g.retry_count as f64 / g.call_count as f64;
            // Weighted composite: success dominates, retry and truncation penalize
            let score = (success_rate * 0.6)
                + ((1.0 - retry_rate.min(1.0)) * 0.2)
                + ((1.0 - truncation_rate.min(1.0)) * 0.2);
            Some(score.clamp(0.0, 1.0))
        } else {
            None
        };

        EfficiencyMetrics {
            context_to_output_ratio,
            system_overhead_pct,
            cost_per_successful_task_cents,
            tokens_saved_pct,
            baseline_method: "full_file_read".to_string(),
            baseline_disclaimer: "Savings are relative to reading entire files. Your results may vary.".to_string(),
            truncation_rate,
            suggestion,
            tokens_per_active_day,
            cost_per_active_day_cents,
            quality_score,
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
                    tokens_in_cache_write: s.tokens_in_cache_write,
                    actual_cost_cents: if s.actual_cost_cents_count > 0 { Some(s.actual_cost_cents) } else { None },
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
    ///
    /// The `access_level` parameter controls what detail level is visible:
    /// - "full": all fields visible (admin)
    /// - "summary": aggregated totals only, no per-call detail
    /// - "redacted": tool names generalized, no cost detail
    pub fn full_stats(&self, session_id: Option<&str>) -> TokenStatsResponse {
        self.full_stats_with_access(session_id, "full")
    }

    /// Build the full stats response with a specified access level.
    pub fn full_stats_with_access(&self, session_id: Option<&str>, access_level: &str) -> TokenStatsResponse {
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

        // Detect orphaned sessions: inactive for > ORPHAN_SESSION_TIMEOUT_MINUTES
        let is_orphaned = session_id.map_or(false, |id| {
            self.is_session_orphaned(id)
        });

        // Check for token count reconciliation issues
        let source_breakdown = self.source_breakdown();
        let total_sources = source_breakdown.api_reported
            + source_breakdown.estimated
            + source_breakdown.unavailable;
        let reconciliation_issue = if total_sources > 0 {
            // If > 50% of events had estimated or unavailable counts, flag it
            let non_api_pct = (source_breakdown.estimated + source_breakdown.unavailable) as f64
                / total_sources as f64;
            non_api_pct > 0.5
        } else {
            false
        };

        let by_tool = self.tool_stats();
        let by_model = self.model_stats();
        let daily_trends = self.daily_trends();
        let efficiency = self.efficiency_metrics();

        // Apply access-level redaction
        let (by_tool, by_model) = match access_level {
            "redacted" => {
                // Generalize tool names at redacted level
                let redacted_tools: Vec<super::ToolTokenStats> = by_tool
                    .into_iter()
                    .map(|mut t| {
                        // Map specific tool names to general categories
                        t.tool = generalize_tool_name(&t.tool);
                        t
                    })
                    .collect();
                // At redacted level, don't show actual cost
                let redacted_models: Vec<super::ModelTokenStats> = by_model
                    .into_iter()
                    .map(|mut m| {
                        m.actual_cost_cents = None;
                        m.cost_estimate_cents = 0;
                        m.cost_unavailable = true;
                        m
                    })
                    .collect();
                (redacted_tools, redacted_models)
            }
            "summary" => (by_tool, by_model), // Same data, caller decides what to display
            _ => (by_tool, by_model), // "full" - no redaction
        };

        let meta = TokenStatsMeta {
            schema_version: TOKEN_USAGE_SCHEMA_VERSION,
            token_count_sources: source_breakdown,
            token_count_reconciliation_issue: reconciliation_issue,
            incomplete_data: false,
            orphaned: is_orphaned,
            access_level: access_level.to_string(),
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
        tokens_in_cache_write: 0,
        actual_cost_cents: None,
        cost_estimate_cents: 0,
        cost_unavailable: true,
        truncation_count: 0,
        retry_count: 0,
        partial_count: 0,
        call_count: 0,
        success_count: 0,
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

/// Generalize a tool name for privacy redaction at lower access levels.
/// Maps specific tool names to broader categories to prevent
/// inference attacks based on tool_name + token volume combos.
fn generalize_tool_name(tool: &str) -> String {
    match tool {
        // Orchestrator calls are generalized
        "orchestrator_plan" | "orchestrator_execute" => "agent".to_string(),
        // All chat-style calls are lumped together
        "chat_completions" | "chat" => "llm".to_string(),
        // Passthrough stays as-is (it's already generic)
        "passthrough" => "passthrough".to_string(),
        // Unknown tools become generic
        _ => "tool".to_string(),
    }
}

/// L3 Verification: Check that daily trend intervals are contiguous.
/// Returns a list of gap descriptions (empty Vec = no gaps).
///
/// Non-contiguous trends can indicate:
/// - Data loss during compaction
/// - Clock skew across days
/// - Missing events on low-activity days
pub fn verify_trend_interval_consistency(trends: &[DailyTokenTrend]) -> Vec<String> {
    if trends.len() < 2 {
        return Vec::new();
    }
    let mut gaps = Vec::new();
    let mut sorted = trends.to_vec();
    sorted.sort_by(|a, b| a.date.cmp(&b.date));
    for window in sorted.windows(2) {
        let prev = &window[0];
        let next = &window[1];
        let prev_date = chrono::NaiveDate::parse_from_str(&prev.date, "%Y-%m-%d").ok();
        let next_date = chrono::NaiveDate::parse_from_str(&next.date, "%Y-%m-%d").ok();
        match (prev_date, next_date) {
            (Some(pd), Some(nd)) => {
                let expected = pd.succ_opt();
                match expected {
                    Some(exp) if exp != nd => {
                        gaps.push(format!(
                            "Gap between {} and {} (expected {})",
                            prev.date, next.date, exp
                        ));
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    gaps
}

/// L3 Verification: Reconcile an L1 session snapshot against its raw events.
///
/// Given a `SessionTokenStats` and the events that supposedly comprise it,
/// verifies that the totals match within an acceptable delta.
///
/// Returns `Ok(())` if reconciled, or `Err(description)` with details.
///
/// This is useful for:
/// - Detecting double-counting or dropped events
/// - Validating store compaction correctness
/// - Catching counter overflow/underflow
pub fn reconcile_l1_snapshot(
    stats: &SessionTokenStats,
    events: &[super::TokenUsageEvent],
) -> Result<(), String> {
    let mut expected_tokens_in_system: u64 = 0;
    let mut expected_tokens_in_user: u64 = 0;
    let mut expected_tokens_in_cached: u64 = 0;
    let mut expected_tokens_out: u64 = 0;
    let mut expected_tokens_truncated: u64 = 0;
    let mut expected_tokens_in_cache_write: u64 = 0;
    let mut expected_call_count: u64 = 0;
    let mut expected_success_count: u64 = 0;
    let mut expected_retry_count: u64 = 0;
    let mut expected_truncation_count: u64 = 0;

    for ev in events {
        expected_tokens_in_system += ev.tokens_in_system;
        expected_tokens_in_user += ev.tokens_in_user;
        expected_tokens_in_cached += ev.tokens_in_cached;
        expected_tokens_out += ev.tokens_out;
        expected_tokens_truncated += ev.tokens_truncated;
        expected_tokens_in_cache_write += ev.tokens_in_cache_write;
        expected_call_count += 1;
        if ev.success {
            expected_success_count += 1;
        }
        if ev.retry_attempt > 0 {
            expected_retry_count += 1;
        }
        if ev.tokens_truncated > 0 {
            expected_truncation_count += 1;
        }
    }

    let mut issues = Vec::new();
    const DELTA_PCT: f64 = 0.01; // 1% tolerance

    fn check(name: &str, actual: u64, expected: u64, issues: &mut Vec<String>) {
        if expected == 0 {
            if actual != 0 {
                issues.push(format!(
                    "{}: expected 0, got {}",
                    name, actual
                ));
            }
            return;
        }
        let delta = (actual as f64 - expected as f64).abs() / expected as f64;
        if delta > DELTA_PCT {
            issues.push(format!(
                "{}: expected {}, got {} (delta {:.2}%)",
                name, expected, actual, delta * 100.0
            ));
        }
    }

    check(
        "tokens_in_system",
        stats.tokens_in_system,
        expected_tokens_in_system,
        &mut issues,
    );
    check(
        "tokens_in_user",
        stats.tokens_in_user,
        expected_tokens_in_user,
        &mut issues,
    );
    check(
        "tokens_in_cached",
        stats.tokens_in_cached,
        expected_tokens_in_cached,
        &mut issues,
    );
    check("tokens_out", stats.tokens_out, expected_tokens_out, &mut issues);
    check(
        "tokens_truncated",
        stats.tokens_truncated,
        expected_tokens_truncated,
        &mut issues,
    );
    check(
        "tokens_in_cache_write",
        stats.tokens_in_cache_write,
        expected_tokens_in_cache_write,
        &mut issues,
    );
    check("call_count", stats.call_count, expected_call_count, &mut issues);
    check(
        "success_count",
        stats.success_count,
        expected_success_count,
        &mut issues,
    );
    check(
        "retry_count",
        stats.retry_count,
        expected_retry_count,
        &mut issues,
    );
    check(
        "truncation_count",
        stats.truncation_count,
        expected_truncation_count,
        &mut issues,
    );

    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues.join("; "))
    }
}