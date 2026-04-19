use crate::config::AppSettings;
use crate::state::SharedState;

#[tauri::command]
pub async fn get_settings(
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    Ok(serde_json::to_value(&s.settings).unwrap_or_default())
}

#[tauri::command]
pub async fn update_settings(
    state: tauri::State<'_, SharedState>,
    settings: serde_json::Value,
) -> Result<(), String> {
    let mut s = state.write().await;
    let updated: AppSettings =
        serde_json::from_value(settings).map_err(|e| format!("Invalid settings: {}", e))?;

    // Apply rate limit changes (rebuild limiter; resets buckets)
    let rate_limit_changed = updated.rate_limit_max_requests_per_minute
        != s.settings.rate_limit_max_requests_per_minute
        || updated.rate_limit_max_requests_per_hour != s.settings.rate_limit_max_requests_per_hour
        || updated.rate_limit_max_concurrent_requests
            != s.settings.rate_limit_max_concurrent_requests;
    if rate_limit_changed {
        s.rate_limiter = crate::security::rate_limit::RateLimiter::new(
            crate::security::rate_limit::RateLimitConfig {
                max_requests_per_minute: updated.rate_limit_max_requests_per_minute,
                max_requests_per_hour: updated.rate_limit_max_requests_per_hour,
                max_concurrent_requests: updated.rate_limit_max_concurrent_requests,
            },
        );
    }

    // Apply clipboard monitoring change
    if updated.clipboard_monitoring != s.settings.clipboard_monitoring {
        if updated.clipboard_monitoring {
            s.clipboard_monitor.start();
        } else {
            s.clipboard_monitor.stop();
        }
    }

    crate::config::store::save_settings(&updated)?;
    s.settings = updated;
    Ok(())
}

