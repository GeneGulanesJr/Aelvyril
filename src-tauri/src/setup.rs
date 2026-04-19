use std::sync::Arc;

use tauri::Manager;
use tokio::sync::RwLock;

use crate::clipboard::{self, ClipboardAction, ClipboardEvent, ClipboardResponse};
use crate::AppState;

/// Start the Presidio Python service and return its base URL.
/// Synchronous startup during app initialization.
pub fn start_presidio_service(state: Arc<RwLock<AppState>>, app: &tauri::AppHandle) -> String {
    let state_clone = state.clone();
    let resource_manager = app
        .path()
        .resolve("presidio_service.py", tauri::path::BaseDirectory::Resource)
        .ok();

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
}

/// Wait for Presidio to become healthy and update the PII engine when ready.
/// This runs in the background and doesn't block startup.
pub fn spawn_presidio_health_check(state: Arc<RwLock<AppState>>, presidio_url: String) {
    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("Failed to create HTTP client for Presidio check: {}", e);
                return;
            }
        };

        let health_url = format!("{}/health", presidio_url);
        let max_attempts = 30;

        for attempt in 1..=max_attempts {
            match client.get(&health_url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    tracing::info!("✅ Presidio service is healthy");
                    enable_presidio_engine(&state, &presidio_url).await;
                    return;
                }
                _ => {
                    if attempt >= max_attempts {
                        tracing::warn!(
                            "Presidio service not healthy after {} attempts. Using custom recognizers only.",
                            max_attempts
                        );
                        disable_presidio_engine(&state).await;
                        return;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            }
        }
    });
}

async fn enable_presidio_engine(state: &Arc<RwLock<AppState>>, url: &str) {
    let state_lock = state.read().await;
    let mut engine = state_lock.pii_engine.write().await;
    engine.set_presidio_url(url.to_string());
    engine.set_presidio_enabled(true);
}

async fn disable_presidio_engine(state: &Arc<RwLock<AppState>>) {
    let state_lock = state.read().await;
    let mut engine = state_lock.pii_engine.write().await;
    engine.set_presidio_enabled(false);
}

/// Spawn the gateway HTTP server in the background.
pub fn spawn_gateway_server(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::gateway::start_server(app).await {
            tracing::error!("Gateway server error: {}", e);
        }
    });
}

/// Spawn the clipboard polling monitor.
pub fn spawn_clipboard_monitor(state: Arc<RwLock<AppState>>) {
    tauri::async_runtime::spawn(async move {
        let monitor = {
            let s = state.read().await;
            s.clipboard_monitor.clone()
        };
        clipboard::monitor::run_clipboard_poll(monitor).await;
    });
}

/// Spawn the clipboard event listener for OS notifications.
pub fn spawn_clipboard_notifications(state: Arc<RwLock<AppState>>) {
    tauri::async_runtime::spawn(async move {
        let rx = {
            let s = state.read().await;
            s.clipboard_monitor.subscribe()
        };

        handle_notification_events(rx, state).await;
    });
}

async fn handle_notification_events(
    mut rx: tokio::sync::broadcast::Receiver<ClipboardEvent>,
    state: Arc<RwLock<AppState>>,
) {
    loop {
        match rx.recv().await {
            Ok(event) => handle_clipboard_event(event, &state).await,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(_) => break,
        }
    }
}

async fn handle_clipboard_event(event: ClipboardEvent, state: &Arc<RwLock<AppState>>) {
    if event.action_taken != ClipboardAction::Pending {
        return;
    }

    let entities: Vec<String> = event
        .detected_entities
        .iter()
        .map(|(t, c)| format!("{} ({})", t, c))
        .collect();

    let msg = format!("PII detected in clipboard: {}", entities.join(", "));

    #[cfg(desktop)]
    show_notification_with_actions(msg, state.clone()).await;
}

#[cfg(desktop)]
async fn show_notification_with_actions(msg: String, state: Arc<RwLock<AppState>>) {
    use notify_rust::Notification;

    let monitor = {
        let s = state.read().await;
        s.clipboard_monitor.clone()
    };

    let mut n = Notification::new();
    n.summary("Aelvyril — Sensitive Content Detected")
        .body(&msg)
        .action("sanitize", "Sanitize")
        .action("allow", "Allow")
        .action("block", "Block");

    let handle = match n.show() {
        Ok(h) => h,
        Err(e) => {
            tracing::warn!("Failed to show notification: {}", e);
            return;
        }
    };

    spawn_notification_handler(handle, monitor);
}

#[cfg(desktop)]
fn spawn_notification_handler(
    handle: notify_rust::NotificationHandle,
    monitor: Arc<clipboard::monitor::ClipboardMonitor>,
) {
    use std::sync::Mutex;

    tauri::async_runtime::spawn_blocking(move || {
        let captured: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let captured_clone = captured.clone();

        handle.wait_for_action(move |action: &str| {
            let value = if action == "__closed" || action.is_empty() {
                None
            } else {
                Some(action.to_string())
            };
            *captured_clone.lock().unwrap() = value;
        });

        let action = captured.lock().unwrap().take();
        let response = parse_notification_action(action.as_deref());

        if let Some(resp) = response {
            if monitor.respond(resp).is_some() {
                tracing::info!("Notification action dispatched");
            }
        } else {
            tracing::debug!("Notification dismissed or timed out");
        }
    });
}

fn parse_notification_action(action: Option<&str>) -> Option<ClipboardResponse> {
    match action {
        Some("sanitize") => Some(ClipboardResponse::Sanitize),
        Some("allow") => Some(ClipboardResponse::Allow),
        Some("block") => Some(ClipboardResponse::Block),
        _ => None,
    }
}
