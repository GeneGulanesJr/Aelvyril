use crate::state::SharedState;

// ── Validation Limits ──

/// Maximum length for a list rule regex pattern
const RULE_PATTERN_MAX_LENGTH: usize = 500;

/// Maximum length for a list rule label
const RULE_LABEL_MAX_LENGTH: usize = 200;

#[tauri::command]
pub async fn list_allow_rules(
    state: tauri::State<'_, SharedState>,
) -> Result<Vec<serde_json::Value>, String> {
    let s = state.read().await;
    Ok(s.list_manager
        .list_allow()
        .into_iter()
        .map(|r| serde_json::to_value(r).unwrap_or_default())
        .collect())
}

#[tauri::command]
pub async fn add_allow_rule(
    state: tauri::State<'_, SharedState>,
    pattern: String,
    label: String,
) -> Result<serde_json::Value, String> {
    // Validate pattern
    let pattern = pattern.trim().to_string();
    if pattern.is_empty() {
        return Err("Pattern cannot be empty".to_string());
    }
    if pattern.len() > RULE_PATTERN_MAX_LENGTH {
        return Err(format!("Pattern cannot exceed {} characters", RULE_PATTERN_MAX_LENGTH));
    }
    // Validate regex syntax
    if regex::Regex::new(&pattern).is_err() {
        return Err("Invalid regex pattern".to_string());
    }
    
    // Validate label
    let label = if label.trim().is_empty() {
        pattern.clone()
    } else {
        label.trim().to_string()
    };
    if label.len() > RULE_LABEL_MAX_LENGTH {
        return Err(format!("Label cannot exceed {} characters", RULE_LABEL_MAX_LENGTH));
    }

    let rule = {
        let s = state.read().await;
        s.list_manager.add_allow(&pattern, &label)?
    };
    crate::pii::sync::sync_pii_engine(state.inner()).await;
    Ok(serde_json::to_value(rule).unwrap_or_default())
}

#[tauri::command]
pub async fn remove_allow_rule(
    state: tauri::State<'_, SharedState>,
    id: String,
) -> Result<(), String> {
    {
        let s = state.read().await;
        s.list_manager.remove_allow(&id);
    }
    crate::pii::sync::sync_pii_engine(state.inner()).await;
    Ok(())
}

#[tauri::command]
pub async fn toggle_allow_rule(
    state: tauri::State<'_, SharedState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    {
        let s = state.read().await;
        s.list_manager.update_allow(&id, enabled);
    }
    crate::pii::sync::sync_pii_engine(state.inner()).await;
    Ok(())
}

#[tauri::command]
pub async fn list_deny_rules(
    state: tauri::State<'_, SharedState>,
) -> Result<Vec<serde_json::Value>, String> {
    let s = state.read().await;
    Ok(s.list_manager
        .list_deny()
        .into_iter()
        .map(|r| serde_json::to_value(r).unwrap_or_default())
        .collect())
}

#[tauri::command]
pub async fn add_deny_rule(
    state: tauri::State<'_, SharedState>,
    pattern: String,
    label: String,
) -> Result<serde_json::Value, String> {
    // Validate pattern
    let pattern = pattern.trim().to_string();
    if pattern.is_empty() {
        return Err("Pattern cannot be empty".to_string());
    }
    if pattern.len() > RULE_PATTERN_MAX_LENGTH {
        return Err(format!("Pattern cannot exceed {} characters", RULE_PATTERN_MAX_LENGTH));
    }
    // Validate regex syntax
    if regex::Regex::new(&pattern).is_err() {
        return Err("Invalid regex pattern".to_string());
    }
    
    // Validate label
    let label = if label.trim().is_empty() {
        pattern.clone()
    } else {
        label.trim().to_string()
    };
    if label.len() > RULE_LABEL_MAX_LENGTH {
        return Err(format!("Label cannot exceed {} characters", RULE_LABEL_MAX_LENGTH));
    }

    let rule = {
        let s = state.read().await;
        s.list_manager.add_deny(&pattern, &label)?
    };
    crate::pii::sync::sync_pii_engine(state.inner()).await;
    Ok(serde_json::to_value(rule).unwrap_or_default())
}

#[tauri::command]
pub async fn remove_deny_rule(
    state: tauri::State<'_, SharedState>,
    id: String,
) -> Result<(), String> {
    {
        let s = state.read().await;
        s.list_manager.remove_deny(&id);
    }
    crate::pii::sync::sync_pii_engine(state.inner()).await;
    Ok(())
}

#[tauri::command]
pub async fn toggle_deny_rule(
    state: tauri::State<'_, SharedState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    {
        let s = state.read().await;
        s.list_manager.update_deny(&id, enabled);
    }
    crate::pii::sync::sync_pii_engine(state.inner()).await;
    Ok(())
}

