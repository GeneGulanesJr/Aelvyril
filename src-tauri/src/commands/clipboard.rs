use crate::state::SharedState;

#[tauri::command]
pub async fn get_clipboard_status(
    state: tauri::State<'_, SharedState>,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    Ok(serde_json::json!({
        "monitoring": s.clipboard_monitor.is_active(),
    }))
}

#[tauri::command]
pub async fn toggle_clipboard_monitor(
    state: tauri::State<'_, SharedState>,
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
pub async fn scan_clipboard_content(
    state: tauri::State<'_, SharedState>,
    content: String,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    let event = s.clipboard_monitor.scan_content(&content);
    Ok(serde_json::to_value(event).unwrap_or_default())
}

#[tauri::command]
pub async fn respond_to_clipboard(
    state: tauri::State<'_, SharedState>,
    response: String,
) -> Result<serde_json::Value, String> {
    let s = state.read().await;
    let resp = match response.as_str() {
        "sanitize" => crate::clipboard::ClipboardResponse::Sanitize,
        "allow" => crate::clipboard::ClipboardResponse::Allow,
        "block" => crate::clipboard::ClipboardResponse::Block,
        _ => return Err("Invalid response. Use: sanitize, allow, or block".into()),
    };
    let event = s.clipboard_monitor.respond(resp);
    Ok(serde_json::to_value(event).unwrap_or_default())
}

