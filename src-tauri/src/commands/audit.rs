use crate::state::SharedState;

#[tauri::command]
pub async fn get_audit_log(
    state: tauri::State<'_, SharedState>,
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
pub async fn export_audit_log(
    state: tauri::State<'_, SharedState>,
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
pub async fn clear_audit_log(state: tauri::State<'_, SharedState>) -> Result<(), String> {
    let s = state.read().await;
    if let Some(ref store) = s.audit_store {
        store.clear_all()
    } else {
        Err("Audit database not available".into())
    }
}

#[tauri::command]
pub async fn get_audit_stats(
    state: tauri::State<'_, SharedState>,
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

