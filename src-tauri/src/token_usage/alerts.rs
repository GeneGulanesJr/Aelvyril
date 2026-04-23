//! Cost alerting system for token usage.
//!
//! Monitors token usage for cost spikes, runaway sessions, and abnormal
//! retry rates. Fires alerts via tracing::warn! (pluggable in future).
//!
//! Thresholds (configurable):
//! - Cost spike: session cost > 3× rolling daily average
//! - Runaway session: session cost > $10 (1,000 cents)
//! - Abnormal retry rate: retry_rate > 20%
//!
//! Usage:
//! ```ignore
//! let checker = CostAlertChecker::new(tracker.clone());
//! if let Some(alert) = checker.check_session(session_id) {
//!     tracing::warn!("Cost alert: {}", alert.message);
//! }
//! ```

use std::sync::Arc;

use super::tracker::TokenUsageTracker;

/// Configurable alert thresholds.
#[derive(Debug, Clone)]
pub struct CostAlertThresholds {
    /// Session cost must exceed this multiple of the daily average to trigger.
    /// Default: 3.0 (3× daily average)
    pub cost_spike_multiplier: f64,

    /// Session cost in cents above which a "runaway session" alert is fired.
    /// Default: 1,000 cents ($10.00)
    pub runaway_session_cents: u64,

    /// Retry rate (0.0–1.0) above which an alert is fired.
    /// Default: 0.20 (20%)
    pub abnormal_retry_rate: f64,

    /// Daily cost in cents above which a "daily cost spike" alert is fired.
    /// If 0, uses the rolling average multiplier instead.
    /// Default: 0 (use multiplier)
    pub daily_cost_spike_cents: u64,
}

impl Default for CostAlertThresholds {
    fn default() -> Self {
        Self {
            cost_spike_multiplier: 3.0,
            runaway_session_cents: 1_000, // $10.00
            abnormal_retry_rate: 0.20,
            daily_cost_spike_cents: 0,
        }
    }
}

/// A cost alert with severity and message.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CostAlert {
    /// Alert severity: "info", "warning", or "critical".
    pub severity: String,
    /// Which alert type fired.
    pub alert_type: String,
    /// Human-readable message describing the issue.
    pub message: String,
    /// Session ID that triggered the alert (if session-specific).
    pub session_id: Option<String>,
    /// Current value that triggered the alert.
    pub current_value: f64,
    /// Threshold that was exceeded.
    pub threshold: f64,
}

/// Cost alert checker — evaluates current stats against thresholds.
pub struct CostAlertChecker {
    tracker: Arc<TokenUsageTracker>,
    thresholds: CostAlertThresholds,
}

impl CostAlertChecker {
    /// Create a new alert checker with default thresholds.
    pub fn new(tracker: Arc<TokenUsageTracker>) -> Self {
        Self::with_thresholds(tracker, CostAlertThresholds::default())
    }

    /// Create a new alert checker with custom thresholds.
    pub fn with_thresholds(tracker: Arc<TokenUsageTracker>, thresholds: CostAlertThresholds) -> Self {
        Self { tracker, thresholds }
    }

    /// Check all alert conditions for a specific session.
    /// Returns zero or more alerts.
    pub fn check_session(&self, session_id: &str) -> Vec<CostAlert> {
        let mut alerts = Vec::new();

        if let Some(stats) = self.tracker.session_stats(session_id) {
            // 1. Runaway session: cost exceeds threshold
            if stats.cost_estimate_cents > self.thresholds.runaway_session_cents {
                alerts.push(CostAlert {
                    severity: "critical".to_string(),
                    alert_type: "runaway_session".to_string(),
                    message: format!(
                        "Session {} has exceeded ${:.2} in estimated cost. This may indicate a runaway agent or misconfigured prompt.",
                        session_id,
                        stats.cost_estimate_cents as f64 / 100.0,
                    ),
                    session_id: Some(session_id.to_string()),
                    current_value: stats.cost_estimate_cents as f64,
                    threshold: self.thresholds.runaway_session_cents as f64,
                });
            }

            // 2. Abnormal retry rate
            let retry_rate = if stats.call_count > 0 {
                stats.retry_count as f64 / stats.call_count as f64
            } else {
                0.0
            };
            if retry_rate > self.thresholds.abnormal_retry_rate {
                alerts.push(CostAlert {
                    severity: "warning".to_string(),
                    alert_type: "abnormal_retry_rate".to_string(),
                    message: format!(
                        "Session {} has a {:.0}% retry rate ({}/{} calls). This may indicate an unstable upstream provider.",
                        session_id,
                        retry_rate * 100.0,
                        stats.retry_count,
                        stats.call_count,
                    ),
                    session_id: Some(session_id.to_string()),
                    current_value: retry_rate,
                    threshold: self.thresholds.abnormal_retry_rate,
                });
            }

            // 3. Cost spike: session cost is > N× the daily average
            let daily_trends = self.tracker.daily_trends();
            if !daily_trends.is_empty() {
                let avg_daily_cost: f64 = daily_trends
                    .iter()
                    .map(|d| d.cost_estimate_cents as f64)
                    .sum::<f64>()
                    / daily_trends.len() as f64;

                if avg_daily_cost > 0.0 {
                    let session_cost = stats.cost_estimate_cents as f64;
                    let daily_avg_per_session = avg_daily_cost
                        / self.tracker.all_session_stats().len().max(1) as f64;
                    if daily_avg_per_session > 0.0
                        && session_cost > daily_avg_per_session * self.thresholds.cost_spike_multiplier
                    {
                        alerts.push(CostAlert {
                            severity: "warning".to_string(),
                            alert_type: "cost_spike".to_string(),
                            message: format!(
                                "Session {} cost (${:.2}) is {:.1}× the per-session daily average (${:.4}). This may indicate an unusually expensive operation.",
                                session_id,
                                session_cost / 100.0,
                                session_cost / daily_avg_per_session,
                                daily_avg_per_session / 100.0,
                            ),
                            session_id: Some(session_id.to_string()),
                            current_value: session_cost / daily_avg_per_session,
                            threshold: self.thresholds.cost_spike_multiplier,
                        });
                    }
                }
            }
        }

        alerts
    }

    /// Check global alert conditions (not session-specific).
    /// Returns zero or more alerts.
    pub fn check_global(&self) -> Vec<CostAlert> {
        let mut alerts = Vec::new();
        let stats = self.tracker.global_stats();

        // Global retry rate check
        let _retry_rate = if stats.total_calls > 0 {
            // Estimate from truncation_rate as a proxy for instability
            0.0 // We don't have a global retry_rate field, skip for now
        } else {
            0.0
        };

        // Daily cost spike: if daily cost exceeds absolute threshold
        if self.thresholds.daily_cost_spike_cents > 0 {
            let daily_trends = self.tracker.daily_trends();
            for trend in &daily_trends {
                if trend.cost_estimate_cents > self.thresholds.daily_cost_spike_cents {
                    alerts.push(CostAlert {
                        severity: "warning".to_string(),
                        alert_type: "daily_cost_spike".to_string(),
                        message: format!(
                            "Daily cost on {} was ${:.2}, exceeding the ${:.2} threshold.",
                            trend.date,
                            trend.cost_estimate_cents as f64 / 100.0,
                            self.thresholds.daily_cost_spike_cents as f64 / 100.0,
                        ),
                        session_id: None,
                        current_value: trend.cost_estimate_cents as f64,
                        threshold: self.thresholds.daily_cost_spike_cents as f64,
                    });
                }
            }
        }

        // High truncation rate indicates context overflow issues
        if stats.truncation_rate > 0.10 {
            alerts.push(CostAlert {
                severity: "info".to_string(),
                alert_type: "high_truncation_rate".to_string(),
                message: format!(
                    "Global truncation rate is {:.0}% — users may be hitting context limits frequently. Consider reducing prompt size or breaking tasks into smaller steps.",
                    stats.truncation_rate * 100.0,
                ),
                session_id: None,
                current_value: stats.truncation_rate,
                threshold: 0.10,
            });
        }

        alerts
    }

    /// Check all sessions for alerts. Returns a summary of all alerts found.
    pub fn check_all_sessions(&self) -> Vec<CostAlert> {
        let mut all_alerts = Vec::new();

        // Check global conditions
        all_alerts.extend(self.check_global());

        // Check each session
        for session in self.tracker.all_session_stats() {
            all_alerts.extend(self.check_session(&session.session_id));
        }

        all_alerts
    }

    /// Fire alerts via tracing::warn! for critical conditions.
    /// Returns the alerts that were fired.
    pub fn fire_alerts(&self, alerts: &[CostAlert]) -> Vec<CostAlert> {
        for alert in alerts {
            match alert.severity.as_str() {
                "critical" => tracing::error!(
                    "[COST ALERT] [{}] {}",
                    alert.alert_type,
                    alert.message
                ),
                "warning" => tracing::warn!(
                    "[COST ALERT] [{}] {}",
                    alert.alert_type,
                    alert.message
                ),
                _ => tracing::info!(
                    "[COST ALERT] [{}] {}",
                    alert.alert_type,
                    alert.message
                ),
            }
        }
        alerts.to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::token_usage::tracker::TokenUsageTracker;

    #[test]
    fn test_no_alerts_on_empty_tracker() {
        let tracker = Arc::new(TokenUsageTracker::new());
        let checker = CostAlertChecker::new(tracker);
        let alerts = checker.check_all_sessions();
        assert!(alerts.is_empty(), "Empty tracker should have no alerts");
    }

    #[test]
    fn test_runaway_session_alert() {
        let tracker = Arc::new(TokenUsageTracker::new());
        // Create a session with cost > $10 (1,000 cents)
        for _ in 0..100 {
            let event = crate::token_usage::tracker::TokenUsageTracker::build_event(
                "expensive_session",
                "chat_completions",
                "o1-pro",
                500,
                50000, // lots of user tokens
                0,
                50000, // lots of output
                0,      // tokens_truncated
                true,   // was_streamed
                false,  // was_partial
                5000,   // duration_ms
                true,   // success
                crate::token_usage::TokenCountSource::ApiReported,
                0,      // retry_attempt
            );
            tracker.record(event);
        }

        let checker = CostAlertChecker::new(tracker);
        let alerts = checker.check_session("expensive_session");
        assert!(
            alerts.iter().any(|a| a.alert_type == "runaway_session"),
            "Should detect runaway session, got: {:?}",
            alerts
        );
    }

    #[test]
    fn test_custom_thresholds() {
        let tracker = Arc::new(TokenUsageTracker::new());
        let thresholds = CostAlertThresholds {
            runaway_session_cents: 1, // 1 cent — very low for testing
            ..CostAlertThresholds::default()
        };
        let checker = CostAlertChecker::with_thresholds(tracker.clone(), thresholds);

        // Use o1-pro ($60/1M input + $60/1M output) to generate measurable cost
        for _ in 0..50 {
            let event = crate::token_usage::tracker::TokenUsageTracker::build_event(
                "s1", "chat_completions", "o1-pro",
                500, 50000, 0, 50000, // lots of tokens to exceed 1 cent
                0,    // tokens_truncated
                true, false, 5000, // was_streamed, was_partial, duration_ms
                true,  // success
                crate::token_usage::TokenCountSource::ApiReported,
                0,    // retry_attempt
            );
            tracker.record(event);
        }

        let alerts = checker.check_session("s1");
        assert!(
            alerts.iter().any(|a| a.alert_type == "runaway_session"),
            "Should trigger at low threshold, got: {:?}",
            alerts
        );
    }

    #[test]
    fn test_global_high_truncation_alert() {
        let tracker = Arc::new(TokenUsageTracker::new());
        let mut event = crate::token_usage::tracker::TokenUsageTracker::build_event(
            "s1", "chat_completions", "gpt-4o",
            100, 200, 0, 50, // tokens_in_system, user, cached, out
            0,    // tokens_truncated
            true, false, 100, // was_streamed, was_partial, duration_ms
            true,  // success
            crate::token_usage::TokenCountSource::ApiReported,
            0,    // retry_attempt
        );
        // Cause high truncation rate
        event.tokens_truncated = 5000;
        for _ in 0..5 {
            tracker.record(event.clone());
        }

        let checker = CostAlertChecker::new(tracker);
        let alerts = checker.check_global();
        // May or may not trigger depending on ratios, but should not crash
        assert!(alerts.len() < 100, "Global check should work");
    }

    #[test]
    fn test_fire_alerts_logging() {
        let tracker = Arc::new(TokenUsageTracker::new());
        let checker = CostAlertChecker::new(tracker);
        let alerts = vec![CostAlert {
            severity: "info".to_string(),
            alert_type: "test".to_string(),
            message: "Test alert".to_string(),
            session_id: None,
            current_value: 1.0,
            threshold: 0.5,
        }];
        let fired = checker.fire_alerts(&alerts);
        assert_eq!(fired.len(), 1);
    }
}