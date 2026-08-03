use std::sync::Arc;

use tauri::Manager;

use crate::clipboard::{ClipboardAction, ClipboardEvent, ClipboardResponse};
use crate::clipboard::monitor::ClipboardMonitor;
use crate::state::SharedState;

// ── Presidio Health Check Constants ──

/// Maximum health check attempts before giving up on Presidio
const PRESIDIO_HEALTH_MAX_ATTEMPTS: u32 = 30;

/// Delay between Presidio health check retries (milliseconds)
const PRESIDIO_HEALTH_RETRY_DELAY_MS: u64 = 500;

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();

    let presidio_url = start_presidio(app);
    spawn_presidio_healthcheck(app, presidio_url);

    // Liquid LFM2.5-Encoder-350M PII detector + Policy-Linter live in the same Python
    // sidecar as Presidio. Wait for the sidecar to come up, then enable the Liquid
    // PII client in the engine. Models are auto-downloaded by the sidecar on first
    // use from Hugging Face.
    spawn_liquid_init(app, presidio_url.clone());
    spawn_liquid_policy_init(app, presidio_url);

    spawn_gateway(handle);
    spawn_clipboard_poll(app);
    spawn_clipboard_notifications(app);

    Ok(())
}

fn start_presidio(app: &mut tauri::App) -> String {
    // Start the Presidio Python service (child process spawn — sync is fine)
    let state = app.state::<SharedState>().inner().clone();
    let state_clone = state.clone();

    // Resolve the bundled script path via Tauri's resource resolver
    let resource_manager = app
        .handle()
        .path()
        .resolve(
            "presidio_service.py",
            tauri::path::BaseDirectory::Resource,
        )
        .ok();

    tauri::async_runtime::block_on(async {
        let state_lock = state_clone.read().await;
        let mut presidio = state_lock.presidio_service.lock();
        // Pull Liquid flags from settings so the sidecar enables the right endpoints.
        presidio.liquid_pii_enabled = state_lock.settings.liquid_pii_enabled;
        presidio.liquid_policy_enabled = state_lock.settings.liquid_policy_enabled;
        if let Some(ref dir) = state_lock.settings.liquid_model_dir {
            presidio.liquid_model_dir = Some(dir.clone());
        }
        if let Err(e) = presidio.start(resource_manager.as_deref()) {
            tracing::warn!(
                "Presidio service failed to start: {}. Using custom recognizers only.",
                e
            );
        }
        presidio.base_url()
    })
}

fn spawn_presidio_healthcheck(app: &mut tauri::App, presidio_url: String) {
    // Wait for Presidio to become healthy (non-blocking — gateway starts regardless)
    let state_for_presidio = app.state::<SharedState>().inner().clone();

    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .unwrap_or_default();

        let health_url = format!("{}/health", presidio_url);
        let mut attempts = 0;
        let max_attempts = PRESIDIO_HEALTH_MAX_ATTEMPTS; // ~15 seconds

        loop {
            match client.get(&health_url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    tracing::info!("✅ Presidio service is healthy");

                    // Update the PII engine with the confirmed sidecar URL.
                    // Presidio and the Liquid encoder clients both point at the
                    // same sidecar; enabling Presidio here enables the Liquid PII
                    // layer too (the sidecar exposes /liquid/pii).
                    let state_lock = state_for_presidio.read().await;
                    let liquid_pii_on = state_lock.settings.liquid_pii_enabled;
                    let mut engine = state_lock.pii_engine.write().await;
                    engine.set_presidio_url(presidio_url);
                    engine.set_presidio_enabled(true);
                    engine.set_liquid_pii_enabled(liquid_pii_on);
                    drop(engine);

                    break;
                }
                _ => {
                    attempts += 1;
                    if attempts >= max_attempts {
                        tracing::warn!(
                            "Presidio service not healthy after {} attempts. Using custom recognizers only.",
                            PRESIDIO_HEALTH_MAX_ATTEMPTS
                        );
                        // Disable Presidio + Liquid in the engine — fall back to custom only
                        let state_lock = state_for_presidio.read().await;
                        let mut engine = state_lock.pii_engine.write().await;
                        engine.set_presidio_enabled(false);
                        engine.set_liquid_pii_enabled(false);
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(PRESIDIO_HEALTH_RETRY_DELAY_MS)).await;
                }
            }
        }
    });
}

/// Enable the Liquid LFM2.5-Encoder PII client once the sidecar is reachable.
/// Models are auto-downloaded by the sidecar on first /liquid/pii request.
/// Failures are non-fatal — the engine degrades to Presidio + regex.
fn spawn_liquid_init(app: &mut tauri::App, presidio_url: String) {
    let state = app.state::<SharedState>().inner().clone();
    tauri::async_runtime::spawn(async move {
        // The healthcheck loop already calls set_liquid_pii_enabled(true). This is a
        // safety net for deployments where the engine is created without going
        // through the Tauri setup path (e.g. the headless bin).
        let s = state.read().await;
        let mut engine = s.pii_engine.write().await;
        engine.set_presidio_url(presidio_url);
        engine.set_liquid_pii_enabled(true);
    });
}

/// Stash the sidecar URL on the engine for the policy linter (separate client
/// instance lives in `crate::policy::linter`). The actual enable happens via
/// config-driven policy settings (see `crate::config`).
fn spawn_liquid_policy_init(_app: &mut tauri::App, _presidio_url: String) {
    // No-op for now: the policy linter reads the URL from config on demand.
    // This hook exists so future work (e.g. background model preload) has a
    // dedicated entry point without touching the PII init path.
}

fn spawn_gateway(handle: tauri::AppHandle) {
    // Spawn the gateway server in the background
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::gateway::start_server(handle).await {
            tracing::error!("Gateway server error: {}", e);
        }
    });
}

fn spawn_clipboard_poll(app: &mut tauri::App) {
    // Spawn clipboard monitor polling
    let state = app.state::<SharedState>().inner().clone();
    tauri::async_runtime::spawn(async move {
        let monitor = {
            let s = state.read().await;
            s.clipboard_monitor.clone()
        };
        crate::clipboard::monitor::run_clipboard_poll(monitor).await;
    });
}

// ── Clipboard Notification Pipeline ──────────────────────────────────────────────

fn spawn_clipboard_notifications(app: &mut tauri::App) {
    let state = app.state::<SharedState>().inner().clone();
    tauri::async_runtime::spawn(async move {
        let rx = {
            let s = state.read().await;
            s.clipboard_monitor.subscribe()
        };
        run_notification_listener(rx, state).await;
    });
}

/// Top-level event loop: receive clipboard events and handle each one.
async fn run_notification_listener(
    mut rx: tokio::sync::broadcast::Receiver<ClipboardEvent>,
    state: SharedState,
) {
    loop {
        match rx.recv().await {
            Ok(event) => handle_clipboard_event(event, &state).await,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(_) => break,
        }
    }
}

/// Process a single clipboard event. Only acts on PII-pending events.
async fn handle_clipboard_event(event: ClipboardEvent, state: &SharedState) {
    if event.action_taken != ClipboardAction::Pending {
        return;
    }

    let msg = format_pii_message(&event.detected_entities);

    #[cfg(desktop)]
    show_notification(msg, state.clone()).await;
}

/// Format detected PII entities into a human-readable notification message.
fn format_pii_message(entities: &[(String, usize)]) -> String {
    let parts: Vec<String> = entities
        .iter()
        .map(|(entity_type, count)| format!("{} ({})", entity_type, count))
        .collect();
    format!("PII detected in clipboard: {}", parts.join(", "))
}

/// Build and show an OS notification with action buttons, then spawn
/// a blocking handler to wait for the user's response.
#[cfg(desktop)]
async fn show_notification(msg: String, state: SharedState) {
    let mut n = notify_rust::Notification::new();
    n.summary("Aelvyril - Sensitive Content Detected")
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

    let monitor = {
        let s = state.read().await;
        s.clipboard_monitor.clone()
    };

    wait_for_notification_action(handle, monitor);
}

/// Capture the user's action from a notification handle.
/// Returns `None` if the notification was dismissed, closed, or timed out.
#[cfg(desktop)]
fn capture_notification_action(handle: notify_rust::NotificationHandle) -> Option<String> {
    use std::sync::Mutex;

    let captured: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let captured_clone = captured.clone();

    handle.wait_for_action(move |action: &str| {
        *captured_clone.lock().unwrap() = if action == "__closed" || action.is_empty() {
            None
        } else {
            Some(action.to_string())
        };
    });

    let result = captured.lock().unwrap().take();
    result
}

/// Spawn a blocking task that waits for the user to click a notification
/// action button, then dispatches the corresponding `ClipboardResponse`.
#[cfg(desktop)]
fn wait_for_notification_action(
    handle: notify_rust::NotificationHandle,
    monitor: Arc<ClipboardMonitor>,
) {
    tauri::async_runtime::spawn_blocking(move || {
        let action = capture_notification_action(handle);
        dispatch_clipboard_response(action.as_deref(), &monitor);
    });
}

/// Map a raw notification action string to a `ClipboardResponse`.
fn parse_notification_action(action: &str) -> Option<ClipboardResponse> {
    match action {
        "sanitize" => Some(ClipboardResponse::Sanitize),
        "allow" => Some(ClipboardResponse::Allow),
        "block" => Some(ClipboardResponse::Block),
        _ => None,
    }
}

/// Dispatch the user's notification response through the clipboard monitor.
fn dispatch_clipboard_response(action: Option<&str>, monitor: &Arc<ClipboardMonitor>) {
    let raw = match action {
        Some(a) => a,
        None => {
            tracing::debug!("Notification dismissed or timed out");
            return;
        }
    };

    let response = match parse_notification_action(raw) {
        Some(resp) => resp,
        None => {
            tracing::debug!("Unknown notification action: {}", raw);
            return;
        }
    };

    let label = match response {
        ClipboardResponse::Sanitize => "sanitize",
        ClipboardResponse::Allow => "allow",
        ClipboardResponse::Block => "block",
    };

    if monitor.respond(response).is_some() {
        tracing::info!("Notification action {} dispatched", label);
    }
}

