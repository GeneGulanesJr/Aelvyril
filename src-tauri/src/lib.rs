pub mod audit;
pub mod bridge;
pub mod clipboard;
pub mod config;
pub mod gateway;
pub mod keychain;
pub mod lists;
pub mod model;
pub mod perf;
pub mod pii;
pub mod pseudonym;
pub mod security;
pub mod session;

use std::sync::Arc;

use tauri::Manager;
use tokio::sync::RwLock;

use audit::store::AuditStore;
use clipboard::monitor::ClipboardMonitor;
use config::AppSettings;
use lists::ListManager;
use perf::benchmark::LatencyBenchmark;
use perf::cache::PiiCache;
use pii::{PiiEngine, PresidioService};
use security::audit::KeyLifecycleAuditor;
use security::rate_limit::RateLimiter;
use session::SessionManager;

/// Shared application state
pub struct AppState {
    pub gateway_key: Option<String>,
    pub gateway_port: u16,
    pub providers: Vec<config::ProviderConfig>,
    pub session_manager: SessionManager,
    pub audit_store: Option<AuditStore>,
    pub settings: AppSettings,
    pub list_manager: ListManager,
    pub clipboard_monitor: Arc<ClipboardMonitor>,
    pub onboarding_complete: bool,
    /// Rate limiter for gateway requests
    pub rate_limiter: RateLimiter,
    /// PII detection result cache
    pub pii_cache: PiiCache,
    /// Latency benchmark tracker
    pub latency_benchmark: LatencyBenchmark,
    /// Key lifecycle auditor
    pub key_auditor: Arc<parking_lot::Mutex<KeyLifecycleAuditor>>,
    /// Shared PII engine — gateway and Tauri commands both reference this
    /// so allow/deny list changes propagate to the hot path immediately.
    pub pii_engine: Arc<RwLock<PiiEngine>>,
    /// Presidio Python service lifecycle manager
    pub presidio_service: Arc<parking_lot::Mutex<PresidioService>>,
}

impl AppState {
    fn new() -> Self {
        let pii_engine = pii::PiiEngine::new();
        let shared_pii_engine = Arc::new(RwLock::new(pii_engine.clone()));
        let clipboard_monitor = Arc::new(ClipboardMonitor::new(pii_engine));

        // Try to open audit database
        let audit_store = open_audit_db();

        Self {
            gateway_key: None,
            gateway_port: 4242,
            providers: Vec::new(),
            session_manager: SessionManager::new(),
            audit_store,
            settings: AppSettings::default(),
            list_manager: ListManager::new(),
            clipboard_monitor,
            onboarding_complete: false,
            rate_limiter: RateLimiter::with_defaults(),
            pii_cache: PiiCache::with_defaults(),
            latency_benchmark: LatencyBenchmark::with_defaults(),
            key_auditor: Arc::new(parking_lot::Mutex::new(
                KeyLifecycleAuditor::with_default_capacity(),
            )),
            pii_engine: shared_pii_engine,
            presidio_service: Arc::new(parking_lot::Mutex::new(PresidioService::new())),
        }
    }
}

fn open_audit_db() -> Option<AuditStore> {
    // Store the audit DB next to the app data
    let db_path = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("aelvyril")
        .join("audit.db");

    // Ensure directory exists
    if let Some(parent) = db_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            tracing::warn!("Failed to create audit DB directory: {}", e);
        }
    }

    match AuditStore::open(&db_path) {
        Ok(store) => {
            tracing::info!("📝 Audit database opened at {:?}", db_path);
            Some(store)
        }
        Err(e) => {
            tracing::warn!("Failed to open audit database: {}", e);
            None
        }
    }
}

/// Rebuild the shared PII engine from the current allow/deny list rules.
/// Called after any list mutation so the gateway's hot path picks up changes.
async fn sync_pii_engine(state: &Arc<RwLock<AppState>>) {
    let (allow_rules, deny_rules) = {
        let s = state.read().await;
        (s.list_manager.list_allow(), s.list_manager.list_deny())
    };

    let mut fresh = pii::PiiEngine::new();
    for rule in allow_rules {
        if rule.enabled {
            let _ = fresh.add_allow_pattern(&rule.pattern);
        }
    }
    for rule in deny_rules {
        if rule.enabled {
            let _ = fresh.add_deny_pattern(&rule.pattern);
        }
    }

    let s = state.read().await;
    *s.pii_engine.write().await = fresh;
}

// ── Tauri Commands ────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Arc::new(RwLock::new(AppState::new())))
        .setup(|app| {
            let handle = app.handle().clone();

            // Start the Presidio Python service (child process spawn — sync is fine)
            let presidio_url = {
                let state = app.state::<Arc<RwLock<AppState>>>().inner();
                let state_clone = state.clone();

                // Resolve the bundled script path via Tauri's resource resolver
                let resource_manager = app.handle().path().resolve("presidio_service.py", tauri::path::BaseDirectory::Resource).ok();

                tauri::async_runtime::block_on(async {
                    let state_lock = state_clone.read().await;
                    let mut presidio = state_lock.presidio_service.lock();
                    if let Err(e) = presidio.start(resource_manager.as_deref()) {
                        tracing::warn!(
                            "Presidio service failed to start: {}. Using custom recognizers only.",
                            e
                        );
                    }
                    presidio.base_url()
                })
            };

            // Wait for Presidio to become healthy (non-blocking — gateway starts regardless)
            let state_for_presidio = app.state::<Arc<RwLock<AppState>>>().inner().clone();
            tauri::async_runtime::spawn(async move {
                let client = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(2))
                    .build()
                    .unwrap_or_default();

                let health_url = format!("{}/health", presidio_url);
                let mut attempts = 0;
                let max_attempts = 30; // ~15 seconds

                loop {
                    match client.get(&health_url).send().await {
                        Ok(resp) if resp.status().is_success() => {
                            tracing::info!("✅ Presidio service is healthy");

                            // Update the PII engine with the confirmed Presidio URL
                            let state_lock = state_for_presidio.read().await;
                            let mut engine = state_lock.pii_engine.write().await;
                            engine.set_presidio_url(presidio_url);
                            engine.set_presidio_enabled(true);
                            drop(engine);

                            break;
                        }
                        _ => {
                            attempts += 1;
                            if attempts >= max_attempts {
                                tracing::warn!(
                                    "Presidio service not healthy after {} attempts. Using custom recognizers only.",
                                    max_attempts
                                );
                                // Disable Presidio in the engine — fall back to custom only
                                let state_lock = state_for_presidio.read().await;
                                let mut engine = state_lock.pii_engine.write().await;
                                engine.set_presidio_enabled(false);
                                break;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        }
                    }
                }
            });

            // Spawn the gateway server in the background
            tauri::async_runtime::spawn(async move {
                if let Err(e) = gateway::start_server(handle).await {
                    tracing::error!("Gateway server error: {}", e);
                }
            });

            // Spawn clipboard monitor polling
            let state = app.state::<Arc<RwLock<AppState>>>().inner().clone();
            tauri::async_runtime::spawn(async move {
                let monitor = {
                    let s = state.read().await;
                    s.clipboard_monitor.clone()
                };
                clipboard::monitor::run_clipboard_poll(monitor).await;
            });

            // Listen for clipboard events → send OS notifications
            let state_for_events = app.state::<Arc<RwLock<AppState>>>().inner().clone();
            tauri::async_runtime::spawn(async move {
                let rx = {
                    let s = state_for_events.read().await;
                    s.clipboard_monitor.subscribe()
                };
                // rx is consumed — we can't hold the state lock across await
                use tokio::sync::broadcast::Receiver;
                let mut rx: Receiver<clipboard::ClipboardEvent> = rx;

                loop {
                    match rx.recv().await {
                        Ok(event) => {
                            if event.action_taken == clipboard::ClipboardAction::Pending {
                                let entities: Vec<String> = event.detected_entities
                                    .iter()
                                    .map(|(t, c)| format!("{} ({})", t, c))
                                    .collect();
                                let msg = format!(
                                    "PII detected in clipboard: {}",
                                    entities.join(", ")
                                );
                                // Try to send OS notification
                                #[cfg(desktop)]
                                {
                                    let monitor_for_action =
                                        state_for_events.clone();

                                    let mut n = notify_rust::Notification::new();
                                    n.summary("Aelvyril — Sensitive Content Detected")
                                        .body(&msg)
                                        .action("sanitize", "Sanitize")
                                        .action("allow", "Allow")
                                        .action("block", "Block");

                                    let handle = n.show();

                                    // Spawn a blocking task to wait for the user's
                                    // notification action response so clicking a button
                                    // actually dispatches a ClipboardResponse.
                                    if let Ok(handle) = handle {
                                        tauri::async_runtime::spawn_blocking(
                                            move || {
                                                use std::sync::Mutex;

                                                let captured: Arc<Mutex<Option<String>>> =
                                                    Arc::new(Mutex::new(None));
                                                let captured_clone = captured.clone();

                                                handle.wait_for_action(move |action: &str| {
                                                    *captured_clone.lock().unwrap() =
                                                        if action == "__closed" || action.is_empty() {
                                                            None
                                                        } else {
                                                            Some(action.to_string())
                                                        };
                                                });

                                                let action = captured.lock().unwrap().take();

                                                let response = match action.as_deref() {
                                                    Some("sanitize") => Some(clipboard::ClipboardResponse::Sanitize),
                                                    Some("allow") => Some(clipboard::ClipboardResponse::Allow),
                                                    Some("block") => Some(clipboard::ClipboardResponse::Block),
                                                    _ => None,
                                                };

                                                if let Some(resp) = response {
                                                    let resp_label =
                                                        match resp {
                                                            clipboard::ClipboardResponse::Sanitize => "sanitize",
                                                            clipboard::ClipboardResponse::Allow => "allow",
                                                            clipboard::ClipboardResponse::Block => "block",
                                                        };
                                                    let monitor = {
                                                        let s = monitor_for_action.blocking_read();
                                                        s.clipboard_monitor.clone()
                                                    };
                                                    if monitor.respond(resp).is_some() {
                                                        tracing::info!(
                                                            "Notification action {} dispatched",
                                                            resp_label
                                                        );
                                                    }
                                                } else {
                                                    tracing::debug!(
                                                        "Notification dismissed or timed out"
                                                    );
                                                }
                                            },
                                        );
                                    }
                                }
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // ── Status & Keys ──
            get_gateway_status,
            generate_gateway_key,
            // ── Providers ──
            add_provider,
            fetch_models,
            remove_provider,
            list_providers,
            // ── Sessions ──
            list_sessions,
            clear_session,
            // ── Audit Log ──
            get_audit_log,
            export_audit_log,
            clear_audit_log,
            get_audit_stats,
            // ── Allow/Deny Lists ──
            list_allow_rules,
            add_allow_rule,
            remove_allow_rule,
            toggle_allow_rule,
            list_deny_rules,
            add_deny_rule,
            remove_deny_rule,
            toggle_deny_rule,
            // ── Settings ──
            get_settings,
            update_settings,
            // ── Clipboard ──
            get_clipboard_status,
            toggle_clipboard_monitor,
            scan_clipboard_content,
            respond_to_clipboard,
            // ── Onboarding ──
            get_onboarding_status,
            complete_onboarding,
            detect_installed_tools,
            // ── Performance & Security (Shot 3) ──
            get_latency_stats,
            get_rate_limit_status,
            get_key_audit_log,
            get_tls_status,
            generate_tls_cert,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── Status & Keys ─────────────────────────────────────────────────────────────

#[tauri::command]
async fn get_gateway_status(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    let stats = s
        .audit_store
        .as_ref()
        .and_then(|store| store.get_stats().ok());
    Ok(serde_json::json!({
        "active": true,
        "port": s.gateway_port,
        "has_key": s.gateway_key.is_some(),
        "provider_count": s.providers.len(),
        "active_sessions": s.session_manager.active_count(),
        "clipboard_monitoring": s.clipboard_monitor.is_active(),
        "onboarding_complete": s.onboarding_complete,
        "stats": stats,
    }))
}

#[tauri::command]
async fn generate_gateway_key(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
) -> Result<String, String> {
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
        security::audit::KeyAction::Created,
        "Generated 64-char random key, stored in OS keychain",
    );

    // Store in OS keychain
    if let Err(e) = keychain::store_gateway_key(&key) {
        tracing::warn!("Failed to store gateway key in keychain: {}", e);
        s.key_auditor.lock().record(
            "gateway-key",
            security::audit::KeyAction::AccessDenied,
            &format!("Keychain store failed: {}", e),
        );
    } else {
        s.key_auditor.lock().record(
            "gateway-key",
            security::audit::KeyAction::Accessed,
            "Stored in OS keychain",
        );
    }

    Ok(key)
}

// ── Providers ─────────────────────────────────────────────────────────────────

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
        base_url: base_url.trim().trim_end_matches('/').to_string(),
        models: models.clone(),
    };

    // Store API key in OS keychain
    if let Err(e) = keychain::store_provider_key(&name, &api_key) {
        return Err(format!("Failed to store API key in keychain: {}", e));
    }

    let mut s = state.write().await;
    s.providers.push(provider.clone());

    // Record in key lifecycle audit
    s.key_auditor.lock().record(
        &format!("provider:{}", name),
        security::audit::KeyAction::Created,
        &format!(
            "Provider added with {} models, key stored in keychain",
            models.len()
        ),
    );

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
    if let Err(e) = keychain::delete_provider_key(&name) {
        tracing::warn!("Failed to delete provider key from keychain: {}", e);
    }
    s.key_auditor.lock().record(
        &format!("provider:{}", name),
        security::audit::KeyAction::Deleted,
        "Provider removed, key deleted from keychain",
    );
    Ok(())
}

#[tauri::command]
async fn fetch_models(base_url: String, api_key: String) -> Result<Vec<String>, String> {
    let client = reqwest::Client::new();
    let models_url = format!("{}/models", base_url.trim().trim_end_matches('/'));

    println!("Fetching models from: {}", models_url);

    let response = client
        .get(&models_url)
        .header("Authorization", format!("Bearer {}", api_key))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch models: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        println!("API request failed: {} - {}", status, body);
        return Err(format!("API request failed with status: {}", status));
    }

    let models_data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    println!("Received response: {:?}", models_data);

    // Handle different API response formats
    let models = if let Some(data) = models_data.get("data") {
        // OpenAI format: { "data": [{ "id": "model-name" }, ...] }
        if let Some(arr) = data.as_array() {
            arr.iter()
                .filter_map(|m| m.get("id")?.as_str().map(|s| s.to_string()))
                .collect()
        } else {
            return Err("Invalid OpenAI format: data is not an array".to_string());
        }
    } else if models_data.is_array() {
        // Some APIs return array directly
        models_data
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|m| m.as_str().map(|s| s.to_string()))
            .collect()
    } else if let Some(models_obj) = models_data.get("models") {
        // Alternative format: { "models": ["model1", "model2"] }
        if let Some(arr) = models_obj.as_array() {
            arr.iter()
                .filter_map(|m| m.as_str().map(|s| s.to_string()))
                .collect()
        } else {
            return Err("Invalid models format: models is not an array".to_string());
        }
    } else {
        // Try to extract from other common formats
        return Err("Unsupported API response format. Expected OpenAI format with 'data' array or direct array".to_string());
    };

    println!("Extracted models: {:?}", models);
    Ok(models)
}

#[tauri::command]
async fn list_providers(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
) -> Result<Vec<serde_json::Value>, String> {
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

// ── Sessions ──────────────────────────────────────────────────────────────────

#[tauri::command]
async fn list_sessions(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
) -> Result<Vec<serde_json::Value>, String> {
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

// ── Audit Log ─────────────────────────────────────────────────────────────────

#[tauri::command]
async fn get_audit_log(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
) -> Result<Vec<serde_json::Value>, String> {
    let s = state.read().await;
    if let Some(ref store) = s.audit_store {
        let entries = store.get_all()?;
        Ok(entries
            .into_iter()
            .map(|e| serde_json::to_value(e).unwrap_or_default())
            .collect())
    } else {
        // Fall back to in-memory audit log
        Ok(s.session_manager.audit_log())
    }
}

#[tauri::command]
async fn export_audit_log(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
    format: String,
) -> Result<String, String> {
    let s = state.read().await;
    if let Some(ref store) = s.audit_store {
        match format.as_str() {
            "csv" => store.export_csv(),
            _ => store.export_json(),
        }
    } else {
        Err("Audit database not available".into())
    }
}

#[tauri::command]
async fn clear_audit_log(state: tauri::State<'_, Arc<RwLock<AppState>>>) -> Result<(), String> {
    let s = state.read().await;
    if let Some(ref store) = s.audit_store {
        store.clear_all()
    } else {
        Err("Audit database not available".into())
    }
}

#[tauri::command]
async fn get_audit_stats(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    if let Some(ref store) = s.audit_store {
        let stats = store.get_stats()?;
        Ok(serde_json::to_value(stats).unwrap_or_default())
    } else {
        Ok(serde_json::json!({
            "total_requests": 0,
            "total_entities": 0,
            "entity_breakdown": [],
        }))
    }
}

// ── Allow/Deny Lists ──────────────────────────────────────────────────────────

#[tauri::command]
async fn list_allow_rules(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
) -> Result<Vec<serde_json::Value>, String> {
    let s = state.read().await;
    Ok(s.list_manager
        .list_allow()
        .into_iter()
        .map(|r| serde_json::to_value(r).unwrap_or_default())
        .collect())
}

#[tauri::command]
async fn add_allow_rule(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
    pattern: String,
    label: String,
) -> Result<serde_json::Value, String> {
    let rule = {
        let s = state.read().await;
        s.list_manager.add_allow(&pattern, &label)?
    };
    sync_pii_engine(state.inner()).await;
    Ok(serde_json::to_value(rule).unwrap_or_default())
}

#[tauri::command]
async fn remove_allow_rule(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
    id: String,
) -> Result<(), String> {
    {
        let s = state.read().await;
        s.list_manager.remove_allow(&id);
    }
    sync_pii_engine(state.inner()).await;
    Ok(())
}

#[tauri::command]
async fn toggle_allow_rule(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    {
        let s = state.read().await;
        s.list_manager.update_allow(&id, enabled);
    }
    sync_pii_engine(state.inner()).await;
    Ok(())
}

#[tauri::command]
async fn list_deny_rules(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
) -> Result<Vec<serde_json::Value>, String> {
    let s = state.read().await;
    Ok(s.list_manager
        .list_deny()
        .into_iter()
        .map(|r| serde_json::to_value(r).unwrap_or_default())
        .collect())
}

#[tauri::command]
async fn add_deny_rule(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
    pattern: String,
    label: String,
) -> Result<serde_json::Value, String> {
    let rule = {
        let s = state.read().await;
        s.list_manager.add_deny(&pattern, &label)?
    };
    sync_pii_engine(state.inner()).await;
    Ok(serde_json::to_value(rule).unwrap_or_default())
}

#[tauri::command]
async fn remove_deny_rule(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
    id: String,
) -> Result<(), String> {
    {
        let s = state.read().await;
        s.list_manager.remove_deny(&id);
    }
    sync_pii_engine(state.inner()).await;
    Ok(())
}

#[tauri::command]
async fn toggle_deny_rule(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    {
        let s = state.read().await;
        s.list_manager.update_deny(&id, enabled);
    }
    sync_pii_engine(state.inner()).await;
    Ok(())
}

// ── Settings ──────────────────────────────────────────────────────────────────

#[tauri::command]
async fn get_settings(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    Ok(serde_json::to_value(&s.settings).unwrap_or_default())
}

#[tauri::command]
async fn update_settings(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
    settings: serde_json::Value,
) -> Result<(), String> {
    let mut s = state.write().await;
    let updated: AppSettings =
        serde_json::from_value(settings).map_err(|e| format!("Invalid settings: {}", e))?;

    // Apply clipboard monitoring change
    if updated.clipboard_monitoring != s.settings.clipboard_monitoring {
        if updated.clipboard_monitoring {
            s.clipboard_monitor.start();
        } else {
            s.clipboard_monitor.stop();
        }
    }

    s.settings = updated;
    Ok(())
}

// ── Clipboard ─────────────────────────────────────────────────────────────────

#[tauri::command]
async fn get_clipboard_status(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    Ok(serde_json::json!({
        "monitoring": s.clipboard_monitor.is_active(),
    }))
}

#[tauri::command]
async fn toggle_clipboard_monitor(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
    enabled: bool,
) -> Result<(), String> {
    let s = state.read().await;
    if enabled {
        s.clipboard_monitor.start();
    } else {
        s.clipboard_monitor.stop();
    }
    Ok(())
}

#[tauri::command]
async fn scan_clipboard_content(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
    content: String,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    let event = s.clipboard_monitor.scan_content(&content);
    Ok(serde_json::to_value(event).unwrap_or_default())
}

#[tauri::command]
async fn respond_to_clipboard(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
    response: String,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    let resp = match response.as_str() {
        "sanitize" => clipboard::ClipboardResponse::Sanitize,
        "allow" => clipboard::ClipboardResponse::Allow,
        "block" => clipboard::ClipboardResponse::Block,
        _ => return Err("Invalid response. Use: sanitize, allow, or block".into()),
    };
    let event = s.clipboard_monitor.respond(resp);
    Ok(serde_json::to_value(event).unwrap_or_default())
}

// ── Onboarding ────────────────────────────────────────────────────────────────

#[tauri::command]
async fn get_onboarding_status(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    Ok(serde_json::json!({
        "complete": s.onboarding_complete,
        "has_key": s.gateway_key.is_some(),
        "has_providers": !s.providers.is_empty(),
    }))
}

#[tauri::command]
async fn complete_onboarding(state: tauri::State<'_, Arc<RwLock<AppState>>>) -> Result<(), String> {
    let mut s = state.write().await;
    s.onboarding_complete = true;
    Ok(())
}

#[tauri::command]
async fn detect_installed_tools() -> Result<serde_json::Value, String> {
    let mut tools = Vec::new();

    // Detect Cursor
    if detect_cursor() {
        tools.push(serde_json::json!({
            "name": "Cursor",
            "config_path": "~/.cursor/config.json",
            "instructions": "Open Cursor Settings → Models → OpenAI API Key. Paste your Aelvyril gateway key there. Set Base URL to http://localhost:4242/v1",
        }));
    }

    // Detect VS Code + Continue extension
    if detect_vscode() {
        tools.push(serde_json::json!({
            "name": "VS Code",
            "config_path": "~/.vscode/settings.json",
            "instructions": "If using the Continue extension, open its config and set the API key to your Aelvyril gateway key with Base URL http://localhost:4242/v1",
        }));
    }

    // Detect Claude Code CLI
    if detect_claude_cli() {
        tools.push(serde_json::json!({
            "name": "Claude Code",
            "config_path": "~/.claude/config.json",
            "instructions": "Set ANTHROPIC_API_KEY to your Aelvyril gateway key and ANTHROPIC_BASE_URL to http://localhost:4242/v1",
        }));
    }

    Ok(serde_json::json!({ "tools": tools }))
}

// ── Performance & Security (Shot 3) ──────────────────────────────────────────

#[tauri::command]
async fn get_latency_stats(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    let stats = s.latency_benchmark.stats();
    Ok(serde_json::to_value(stats).unwrap_or_default())
}

#[tauri::command]
async fn get_rate_limit_status(
    _state: tauri::State<'_, Arc<RwLock<AppState>>>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "max_requests_per_minute": 60,
        "max_requests_per_hour": 1000,
        "max_concurrent": 10,
    }))
}

#[tauri::command]
async fn get_key_audit_log(
    state: tauri::State<'_, Arc<RwLock<AppState>>>,
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
async fn get_tls_status() -> Result<serde_json::Value, String> {
    let config = security::tls::TlsConfig::default();
    let valid = config.validate().ok();
    Ok(serde_json::json!({
        "enabled": config.enabled,
        "files_exist": config.files_exist(),
        "validity": valid,
    }))
}

#[tauri::command]
async fn generate_tls_cert() -> Result<serde_json::Value, String> {
    let mut config = security::tls::TlsConfig {
        enabled: true,
        ..Default::default()
    };
    config.generate_self_signed()?;
    Ok(serde_json::json!({
        "success": true,
        "cert_path": config.cert_path.to_string_lossy(),
    }))
}

fn detect_cursor() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::path::Path::new("/Applications/Cursor.app").exists()
            || std::path::Path::new(&std::env::var("HOME").unwrap_or_default())
                .join(".cursor")
                .exists()
    }
    #[cfg(target_os = "linux")]
    {
        std::path::Path::new("/usr/bin/cursor").exists()
            || std::path::Path::new(&std::env::var("HOME").unwrap_or_default())
                .join(".cursor")
                .exists()
    }
    #[cfg(target_os = "windows")]
    {
        std::path::Path::new(r"C:\Program Files\Cursor").exists()
            || std::path::Path::new(&std::env::var("USERPROFILE").unwrap_or_default())
                .join(".cursor")
                .exists()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        false
    }
}

fn detect_vscode() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::path::Path::new("/Applications/Visual Studio Code.app").exists()
    }
    #[cfg(target_os = "linux")]
    {
        std::path::Path::new("/usr/bin/code").exists()
    }
    #[cfg(target_os = "windows")]
    {
        std::path::Path::new(r"C:\Program Files\Microsoft VS Code").exists()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        false
    }
}

fn detect_claude_cli() -> bool {
    std::process::Command::new("which")
        .arg("claude")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}
