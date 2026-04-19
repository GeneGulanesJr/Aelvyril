use crate::state::SharedState;

#[tauri::command]
pub async fn get_gateway_status(
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    let stats = s
        .audit_store
        .as_ref()
        .and_then(|store| store.get_stats().ok());
    let url = format!("http://{}:{}", s.gateway_bind_address, s.gateway_port);
    Ok(serde_json::json!({
        "active": true,
        "port": s.gateway_port,
        "bind_address": s.gateway_bind_address,
        "url": url,
        "health_endpoint": format!("{}/health", url),
        "has_key": s.gateway_key.is_some(),
        "provider_count": s.providers.len(),
        "active_sessions": s.session_manager.active_count(),
        "clipboard_monitoring": s.clipboard_monitor.is_active(),
        "onboarding_complete": s.onboarding_complete,
        "stats": stats,
    }))
}

#[tauri::command]
pub async fn generate_gateway_key(state: tauri::State<'_, SharedState>) -> Result<String, String> {
    use rand::Rng;
    let key = {
        let mut rng = rand::rng();
        let key: String = (0..32)
            .map(|_| {
                const CHARSET: &[u8] =
                    b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
                CHARSET[rng.random_range(0..CHARSET.len())] as char
            })
            .collect();
        format!("aelvyril-{}", key)
    };

    let mut s = state.write().await;
    s.gateway_key = Some(key.clone());

    // Record in key lifecycle audit
    s.key_auditor.lock().record(
        "gateway-key",
        crate::security::audit::KeyAction::Created,
        "Generated 64-char random key, stored in OS keychain",
    );

    // Store in OS keychain
    if let Err(e) = crate::keychain::store_gateway_key(&key) {
        tracing::warn!("Failed to store gateway key in keychain: {}", e);
        s.key_auditor.lock().record(
            "gateway-key",
            crate::security::audit::KeyAction::AccessDenied,
            &format!("Keychain store failed: {}", e),
        );
    } else {
        s.key_auditor.lock().record(
            "gateway-key",
            crate::security::audit::KeyAction::Accessed,
            "Stored in OS keychain",
        );
    }

    Ok(key)
}

