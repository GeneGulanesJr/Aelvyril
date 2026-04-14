mod config;
mod gateway;
mod keychain;
mod model;
mod pii;
mod pseudonym;
mod session;

use std::sync::Arc;

use tokio::sync::RwLock;

use session::SessionManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Arc::new(RwLock::new(AppState::new())))
        .setup(|app| {
            let handle = app.handle().clone();

            // Spawn the gateway server in the background
            tauri::async_runtime::spawn(async move {
                if let Err(e) = gateway::start_server(handle).await {
                    tracing::error!("Gateway server error: {}", e);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_gateway_status,
            generate_gateway_key,
            add_provider,
            remove_provider,
            list_providers,
            list_sessions,
            clear_session,
            get_audit_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Shared application state
pub struct AppState {
    pub gateway_key: Option<String>,
    pub gateway_port: u16,
    pub providers: Vec<config::ProviderConfig>,
    pub session_manager: SessionManager,
}

impl AppState {
    fn new() -> Self {
        Self {
            gateway_key: None,
            gateway_port: 4242,
            providers: Vec::new(),
            session_manager: SessionManager::new(),
        }
    }
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command]
async fn get_gateway_status(state: tauri::State<'_, Arc<RwLock<AppState>>>) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    Ok(serde_json::json!({
        "active": true,
        "port": s.gateway_port,
        "has_key": s.gateway_key.is_some(),
        "provider_count": s.providers.len(),
        "active_sessions": s.session_manager.active_count(),
    }))
}

#[tauri::command]
async fn generate_gateway_key(state: tauri::State<'_, Arc<RwLock<AppState>>>) -> Result<String, String> {
    use rand::Rng;
    let key = {
        let mut rng = rand::rng();
        let key: String = (0..32)
            .map(|_| {
                const CHARSET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
                CHARSET[rng.random_range(0..CHARSET.len())] as char
            })
            .collect();
        format!("aelvyril-{}", key)
    };

    let mut s = state.write().await;
    s.gateway_key = Some(key.clone());

    // Store in OS keychain
    if let Err(e) = keychain::store_gateway_key(&key) {
        tracing::warn!("Failed to store gateway key in keychain: {}", e);
    }

    Ok(key)
}

#[tauri::command]
async fn add_provider(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
    name: String,
    base_url: String,
    models: Vec<String>,
    api_key: String,
) -> Result<serde_json::Value, String> {
    let provider = config::ProviderConfig {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.clone(),
        base_url: base_url.trim_end_matches('/').to_string(),
        models: models.clone(),
    };

    // Store API key in OS keychain
    if let Err(e) = keychain::store_provider_key(&name, &api_key) {
        return Err(format!("Failed to store API key in keychain: {}", e));
    }

    let mut s = state.write().await;
    s.providers.push(provider.clone());

    Ok(serde_json::json!({
        "id": provider.id,
        "name": provider.name,
        "base_url": provider.base_url,
        "models": provider.models,
    }))
}

#[tauri::command]
async fn remove_provider(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
    name: String,
) -> Result<(), String> {
    let mut s = state.write().await;
    s.providers.retain(|p| p.name != name);

    // Remove from keychain
    let _ = keychain::delete_provider_key(&name);

    Ok(())
}

#[tauri::command]
async fn list_providers(state: tauri::State<'_, Arc<RwLock<AppState>>>) -> Result<Vec<serde_json::Value>, String> {
    let s = state.read().await;
    Ok(s.providers
        .iter()
        .map(|p| {
            serde_json::json!({
                "id": p.id,
                "name": p.name,
                "base_url": p.base_url,
                "models": p.models,
            })
        })
        .collect())
}

#[tauri::command]
async fn list_sessions(state: tauri::State<'_, Arc<RwLock<AppState>>>) -> Result<Vec<serde_json::Value>, String> {
    let s = state.read().await;
    Ok(s.session_manager.list())
}

#[tauri::command]
async fn clear_session(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
    session_id: String,
) -> Result<(), String> {
    let s = state.read().await;
    s.session_manager.clear(&session_id);
    Ok(())
}

#[tauri::command]
async fn get_audit_log(state: tauri::State<'_, Arc<RwLock<AppState>>>) -> Result<Vec<serde_json::Value>, String> {
    let s = state.read().await;
    Ok(s.session_manager.audit_log())
}
