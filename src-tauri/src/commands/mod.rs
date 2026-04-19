mod audit;
mod clipboard;
mod lists;
mod onboarding;
mod providers;
mod security;
mod sessions;
mod settings;
mod status;
mod token_usage;

pub use audit::*;
pub use clipboard::*;
pub use lists::*;
pub use onboarding::*;
pub use providers::*;
pub use security::*;
pub use sessions::*;
pub use settings::*;
pub use status::*;
pub use token_usage::*;

pub fn invoke_handler<R: tauri::Runtime>(
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
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
        // ── Token Usage Stats ──
        get_token_stats,
        get_token_stats_for_session,
        get_token_stats_full,
        get_token_stats_by_tool,
        get_token_stats_by_model,
        get_token_trends,
        get_token_efficiency,
        reset_token_stats,
        export_token_stats,
    ]
}

