use crate::state::SharedState;

#[tauri::command]
pub async fn get_latency_stats(
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    let stats = s.latency_benchmark.stats();
    Ok(serde_json::to_value(stats).unwrap_or_default())
}

#[tauri::command]
pub async fn get_rate_limit_status(
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    Ok(serde_json::json!({
        "max_requests_per_minute": s.settings.rate_limit_max_requests_per_minute,
        "max_requests_per_hour": s.settings.rate_limit_max_requests_per_hour,
        "max_concurrent": s.settings.rate_limit_max_concurrent_requests,
    }))
}

#[tauri::command]
pub async fn get_key_audit_log(
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    let auditor = s.key_auditor.lock();
    let events: Vec<serde_json::Value> = auditor
        .events()
        .iter()
        .map(|e| serde_json::to_value(e).unwrap_or_default())
        .collect();
    Ok(serde_json::json!({ "events": events }))
}

#[tauri::command]
pub async fn get_tls_status() -> Result<serde_json::Value, String> {
    let config = crate::security::tls::TlsConfig::default();
    let valid = config.validate().ok();
    Ok(serde_json::json!({
        "enabled": config.enabled,
        "files_exist": config.files_exist(),
        "validity": valid,
    }))
}

#[tauri::command]
pub async fn generate_tls_cert() -> Result<serde_json::Value, String> {
    let mut config = crate::security::tls::TlsConfig {
        enabled: true,
        ..Default::default()
    };
    config.generate_self_signed()?;
    Ok(serde_json::json!({
        "success": true,
        "cert_path": config.cert_path.to_string_lossy(),
    }))
}

