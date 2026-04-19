use crate::state::SharedState;

#[tauri::command]
pub async fn list_sessions(
    state: tauri::State<'_, SharedState>,
) -> Result<Vec<serde_json::Value>, String> {
    let s = state.read().await;
    Ok(s.session_manager.list())
}

#[tauri::command]
pub async fn clear_session(
    state: tauri::State<'_, SharedState>,
    session_id: String,
) -> Result<(), String> {
    let s = state.read().await;
    s.session_manager.clear(&session_id);
    Ok(())
}

