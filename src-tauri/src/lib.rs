pub mod audit;
pub mod bridge;
pub mod clipboard;
pub mod config;
pub mod gateway;
pub mod keychain;
pub mod llama;
pub mod lists;
pub mod perf;
pub mod pii;
pub mod policy;
pub mod providers;
pub mod pseudonym;
pub mod security;
pub mod session;
pub mod onboarding;
pub mod bootstrap;
pub mod commands;
pub mod state;
pub mod token_usage;

use std::sync::Arc;

use tokio::sync::RwLock;

use state::AppState;

// ── Tauri Commands ────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Arc::new(RwLock::new(AppState::new())))
        .setup(bootstrap::setup::setup)
        .invoke_handler(commands::invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
