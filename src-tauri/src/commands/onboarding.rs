use crate::state::SharedState;

#[tauri::command]
pub async fn get_onboarding_status(
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    Ok(serde_json::json!({
        "complete": s.onboarding_complete,
        "has_key": s.gateway_key.is_some(),
        "has_providers": !s.providers.is_empty(),
    }))
}

#[tauri::command]
pub async fn complete_onboarding(state: tauri::State<'_, SharedState>) -> Result<(), String> {
    let mut s = state.write().await;
    s.onboarding_complete = true;
    Ok(())
}

#[tauri::command]
pub async fn detect_installed_tools() -> Result<serde_json::Value, String> {
    let mut tools = Vec::new();

    // Detect Cursor
    if crate::onboarding::tool_detection::detect_cursor() {
        tools.push(serde_json::json!({
            "name": "Cursor",
            "config_path": "~/.cursor/config.json",
            "instructions": "Open Cursor Settings → Models → OpenAI API Key. Paste your Aelvyril gateway key there. Set Base URL to http://localhost:4242/v1",
        }));
    }

    // Detect VS Code + Continue extension
    if crate::onboarding::tool_detection::detect_vscode() {
        tools.push(serde_json::json!({
            "name": "VS Code",
            "config_path": "~/.vscode/settings.json",
            "instructions": "If using the Continue extension, open its config and set the API key to your Aelvyril gateway key with Base URL http://localhost:4242/v1",
        }));
    }

    // Detect Claude Code CLI
    if crate::onboarding::tool_detection::detect_claude_cli() {
        tools.push(serde_json::json!({
            "name": "Claude Code",
            "config_path": "~/.claude/config.json",
            "instructions": "Set ANTHROPIC_API_KEY to your Aelvyril gateway key and ANTHROPIC_BASE_URL to http://localhost:4242/v1",
        }));
    }

    Ok(serde_json::json!({ "tools": tools }))
}

