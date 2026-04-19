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
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Arc::new(RwLock::new(AppState::new())))
        .setup(bootstrap::setup::setup)
        .invoke_handler(commands::invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
