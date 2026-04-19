use crate::state::SharedState;

/// Get global token usage stats for the dashboard.
#[tauri::command]
pub async fn get_token_stats(
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    let stats = s.token_usage_tracker.global_stats();
    Ok(serde_json::to_value(stats).unwrap_or_default())
}

/// Get detailed token stats for a specific session.
#[tauri::command]
pub async fn get_token_stats_for_session(
    state: tauri::State<'_, SharedState>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
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
    let tracker = &s.token_usage_tracker;
    let full_stats = tracker.full_stats(None);
    Ok(serde_json::to_value(full_stats).unwrap_or_default())
}

/// Get per-tool token breakdown (L2).
#[tauri::command]
pub async fn get_token_stats_by_tool(
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    let stats = s.token_usage_tracker.tool_stats();
    Ok(serde_json::to_value(stats).unwrap_or_default())
}

/// Get per-model token breakdown (L2).
#[tauri::command]
pub async fn get_token_stats_by_model(
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    let stats = s.token_usage_tracker.model_stats();
    Ok(serde_json::to_value(stats).unwrap_or_default())
}

/// Get daily token usage trends (L3).
#[tauri::command]
pub async fn get_token_trends(
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    let trends = s.token_usage_tracker.daily_trends();
    Ok(serde_json::to_value(trends).unwrap_or_default())
}

/// Get efficiency metrics (L4).
#[tauri::command]
pub async fn get_token_efficiency(
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    let efficiency = s.token_usage_tracker.efficiency_metrics();
    Ok(serde_json::to_value(efficiency).unwrap_or_default())
}

/// Clear all token usage stats (for testing or reset).
#[tauri::command]
pub async fn reset_token_stats(
    state: tauri::State<'_, SharedState>,
) -> Result<(), String> {
    let s = state.read().await;
    s.token_usage_tracker.clear();
    Ok(())
}

/// Export token usage stats as JSON.
#[tauri::command]
pub async fn export_token_stats(
    state: tauri::State<'_, SharedState>,
) -> Result<String, String> {
    let s = state.read().await;
    let stats = s.token_usage_tracker.global_stats();
    serde_json::to_string_pretty(&stats).map_err(|e| format!("Failed to serialize: {}", e))
}