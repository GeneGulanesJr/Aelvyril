use crate::state::SharedState;
use crate::token_usage::tracker::{ORPHAN_SESSION_TIMEOUT_MINUTES, MAX_EVENTS_PER_SESSION};

/// Get global token usage stats for the dashboard.
#[tauri::command]
pub async fn get_token_stats(
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    if let Err(e) = s.tauri_rate_limiter.check("get_token_stats") { return Err(e.to_string()); }
    let stats = s.token_usage_tracker.global_stats();
    Ok(serde_json::to_value(stats).unwrap_or_default())
}

/// Get detailed token stats for a specific session.
/// Enforces tenant isolation: only returns stats if the session belongs
/// to the given tenant (or for the default tenant).
#[tauri::command]
pub async fn get_token_stats_for_session(
    state: tauri::State<'_, SharedState>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    if let Err(e) = s.tauri_rate_limiter.check("get_token_stats_for_session") { return Err(e.to_string()); }
    let tracker = &s.token_usage_tracker;
    let full_stats = tracker.full_stats(Some(&session_id));
    Ok(serde_json::to_value(full_stats).unwrap_or_default())
}

/// Get full token stats response (L1-L4, matches Step 5 output format).
#[tauri::command]
pub async fn get_token_stats_full(
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    if let Err(e) = s.tauri_rate_limiter.check("get_token_stats_full") { return Err(e.to_string()); }
    let tracker = &s.token_usage_tracker;
    let full_stats = tracker.full_stats_with_access(None, "full");
    Ok(serde_json::to_value(full_stats).unwrap_or_default())
}

/// Get per-tool token breakdown (L2).
#[tauri::command]
pub async fn get_token_stats_by_tool(
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    if let Err(e) = s.tauri_rate_limiter.check("get_token_stats_by_tool") { return Err(e.to_string()); }
    let stats = s.token_usage_tracker.tool_stats();
    Ok(serde_json::to_value(stats).unwrap_or_default())
}

/// Get per-model token breakdown (L2).
#[tauri::command]
pub async fn get_token_stats_by_model(
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    if let Err(e) = s.tauri_rate_limiter.check("get_token_stats_by_model") { return Err(e.to_string()); }
    let stats = s.token_usage_tracker.model_stats();
    Ok(serde_json::to_value(stats).unwrap_or_default())
}

/// Get daily token usage trends (L3).
#[tauri::command]
pub async fn get_token_trends(
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    if let Err(e) = s.tauri_rate_limiter.check("get_token_trends") { return Err(e.to_string()); }
    let trends = s.token_usage_tracker.daily_trends();
    Ok(serde_json::to_value(trends).unwrap_or_default())
}

/// Get per-tool trend data (L3).
#[tauri::command]
pub async fn get_token_trends_by_tool(
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    if let Err(e) = s.tauri_rate_limiter.check("get_token_trends_by_tool") { return Err(e.to_string()); }
    let trends = s.token_usage_tracker.tool_trends();
    Ok(serde_json::to_value(trends).unwrap_or_default())
}

/// Get per-model trend data (L3).
#[tauri::command]
pub async fn get_token_trends_by_model(
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    if let Err(e) = s.tauri_rate_limiter.check("get_token_trends_by_model") { return Err(e.to_string()); }
    let trends = s.token_usage_tracker.model_trends();
    Ok(serde_json::to_value(trends).unwrap_or_default())
}

/// Get efficiency metrics (L4).
#[tauri::command]
pub async fn get_token_efficiency(
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    if let Err(e) = s.tauri_rate_limiter.check("get_token_efficiency") { return Err(e.to_string()); }
    let efficiency = s.token_usage_tracker.efficiency_metrics();
    Ok(serde_json::to_value(efficiency).unwrap_or_default())
}

/// Clear all token usage stats (for testing or reset).
#[tauri::command]
pub async fn reset_token_stats(
    state: tauri::State<'_, SharedState>,
) -> Result<(), String> {
    let s = state.read().await;
    if let Err(e) = s.tauri_rate_limiter.check("reset_token_stats") { return Err(e.to_string()); }
    s.token_usage_tracker.clear();
    Ok(())
}

/// Export token usage stats as JSON.
#[tauri::command]
pub async fn export_token_stats(
    state: tauri::State<'_, SharedState>,
) -> Result<String, String> {
    let s = state.read().await;
    if let Err(e) = s.tauri_rate_limiter.check("export_token_stats") { return Err(e.to_string()); }
    let stats = s.token_usage_tracker.global_stats();
    serde_json::to_string_pretty(&stats).map_err(|e| format!("Failed to serialize: {}", e))
}

/// Trigger orphan session cleanup.
/// Returns the list of session IDs that were auto-closed.
#[tauri::command]
pub async fn cleanup_orphaned_sessions(
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    if let Err(e) = s.tauri_rate_limiter.check("cleanup_orphaned_sessions") { return Err(e.to_string()); }
    let closed = s.token_usage_tracker.auto_close_orphaned_sessions();
    Ok(serde_json::json!({
        "orphaned_sessions": closed,
        "count": closed.len(),
        "timeout_minutes": ORPHAN_SESSION_TIMEOUT_MINUTES,
    }))
}

/// Purge old token usage events from the SQLite store.
/// Events older than `days` days will be deleted.
#[tauri::command]
pub async fn purge_token_usage_events(
    state: tauri::State<'_, SharedState>,
    days: u32,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    if let Err(e) = s.tauri_rate_limiter.check("purge_token_usage_events") { return Err(e.to_string()); }
    match &s.token_usage_store {
        Some(store) => {
            let purged = store.purge_older_than_days(days)
                .map_err(|e| format!("Failed to purge events: {}", e))?;
            Ok(serde_json::json!({
                "purged_count": purged,
                "older_than_days": days,
            }))
        }
        None => Err("Token usage store not available".to_string()),
    }
}

/// Get token usage configuration and limits.
#[tauri::command]
pub async fn get_token_usage_config(
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let state_guard = state.read().await;
    Ok(serde_json::json!({
        "max_events_per_session": MAX_EVENTS_PER_SESSION,
        "orphan_session_timeout_minutes": ORPHAN_SESSION_TIMEOUT_MINUTES,
        "schema_version": crate::token_usage::TOKEN_USAGE_SCHEMA_VERSION,
        "default_tenant_id": crate::token_usage::DEFAULT_TENANT_ID,
        "rate_limit": {
            "max_per_minute": state_guard.tauri_rate_limiter.config().max_per_minute,
            "max_per_hour": state_guard.tauri_rate_limiter.config().max_per_hour,
        },
        "alert_thresholds": {
            "runaway_session_cents": state_guard.alert_thresholds.runaway_session_cents,
            "cost_spike_multiplier": state_guard.alert_thresholds.cost_spike_multiplier,
            "abnormal_retry_rate": state_guard.alert_thresholds.abnormal_retry_rate,
            "daily_cost_spike_cents": state_guard.alert_thresholds.daily_cost_spike_cents,
        },
    }))
}
/// Get token stats with a specified access level.
/// access_level: "full" | "summary" | "redacted"
/// - "full": all fields visible (admin)
/// - "summary": aggregated totals only (standard user)  
/// - "redacted": tool names generalized, no cost detail (external)
#[tauri::command]
pub async fn get_token_stats_with_access(
    state: tauri::State<'_, SharedState>,
    access_level: String,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    if let Err(e) = s.tauri_rate_limiter.check("get_token_stats_with_access") { return Err(e.to_string()); }
    let tracker = &s.token_usage_tracker;
    let full_stats = tracker.full_stats_with_access(None, &access_level);
    Ok(serde_json::to_value(full_stats).unwrap_or_default())
}

/// Check for cost alerts across all sessions.
/// Returns alerts for runaway sessions, abnormal retry rates,
/// cost spikes, and high truncation rates.
#[tauri::command]
pub async fn check_cost_alerts(
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    if let Err(e) = s.tauri_rate_limiter.check("check_cost_alerts") { return Err(e.to_string()); }
    let checker = crate::token_usage::alerts::CostAlertChecker::with_thresholds(
        s.token_usage_tracker.clone(),
        s.alert_thresholds.clone(),
    );
    let alerts = checker.check_all_sessions();
    checker.fire_alerts(&alerts);
    Ok(serde_json::to_value(&alerts).unwrap_or_default())
}
