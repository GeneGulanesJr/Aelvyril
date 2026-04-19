use crate::state::SharedState;

// ── Validation Limits ──

/// Maximum length for a provider display name
const PROVIDER_NAME_MAX_LENGTH: usize = 100;

/// Maximum length for a provider base URL
const PROVIDER_URL_MAX_LENGTH: usize = 500;

/// Minimum length for an API key
const API_KEY_MIN_LENGTH: usize = 10;

/// Maximum length for an API key
const API_KEY_MAX_LENGTH: usize = 500;

/// Maximum number of models per provider
const MAX_MODELS_PER_PROVIDER: usize = 50;

/// Default HTTP timeout (seconds) for model fetching
const FETCH_MODELS_DEFAULT_TIMEOUT_SECS: u64 = 10;

#[tauri::command]
pub async fn add_provider(
    state: tauri::State<'_, SharedState>,
    name: String,
    base_url: String,
    models: Vec<String>,
    api_key: String,
) -> Result<serde_json::Value, String> {
    // Validate provider name
    if name.trim().is_empty() {
        return Err("Provider name cannot be empty".to_string());
    }
    if name.len() > PROVIDER_NAME_MAX_LENGTH {
        return Err(format!("Provider name cannot exceed {} characters", PROVIDER_NAME_MAX_LENGTH));
    }
    if !name.chars().all(|c| c.is_alphanumeric() || c.is_whitespace() || c == '-' || c == '_') {
        return Err("Provider name contains invalid characters".to_string());
    }

    // Validate base URL
    let base_url = base_url.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() {
        return Err("Base URL cannot be empty".to_string());
    }
    if base_url.len() > PROVIDER_URL_MAX_LENGTH {
        return Err(format!("Base URL cannot exceed {} characters", PROVIDER_URL_MAX_LENGTH));
    }
    if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
        return Err("Base URL must start with http:// or https://".to_string());
    }
    
    // Validate URL format
    if let Err(e) = url::Url::parse(&base_url) {
        return Err(format!("Invalid base URL: {}", e));
    }

    // Validate API key
    if api_key.len() < API_KEY_MIN_LENGTH {
        return Err(format!("API key must be at least {} characters", API_KEY_MIN_LENGTH));
    }
    if api_key.len() > API_KEY_MAX_LENGTH {
        return Err(format!("API key cannot exceed {} characters", API_KEY_MAX_LENGTH));
    }

    // Validate models
    let models: Vec<String> = models
        .iter()
        .filter(|m| !m.trim().is_empty())
        .map(|m| m.trim().to_string())
        .take(MAX_MODELS_PER_PROVIDER)
        .collect();

    let provider = crate::config::ProviderConfig {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.clone(),
        base_url,
        models: models.clone(),
    };

    // Store API key in OS keychain
    if let Err(e) = crate::keychain::store_provider_key(&name, &api_key) {
        return Err(format!("Failed to store API key in keychain: {}", e));
    }

    let mut s = state.write().await;
    s.providers.push(provider.clone());

    // Record in key lifecycle audit
    s.key_auditor.lock().record(
        &format!("provider:{}", name),
        crate::security::audit::KeyAction::Created,
        &format!(
            "Provider added with {} models, key stored in keychain",
            models.len()
        ),
    );

    Ok(serde_json::json!({
        "id": provider.id,
        "name": provider.name,
        "base_url": provider.base_url,
        "models": provider.models,
    }))
}

#[tauri::command]
pub async fn remove_provider(
    state: tauri::State<'_, SharedState>,
    name: String,
) -> Result<(), String> {
    let mut s = state.write().await;
    s.providers.retain(|p| p.name != name);
    if let Err(e) = crate::keychain::delete_provider_key(&name) {
        tracing::warn!("Failed to delete provider key from keychain: {}", e);
    }
    s.key_auditor.lock().record(
        &format!("provider:{}", name),
        crate::security::audit::KeyAction::Deleted,
        "Provider removed, key deleted from keychain",
    );
    Ok(())
}

#[tauri::command]
pub async fn fetch_models(base_url: String, api_key: String, timeout_secs: Option<u64>) -> Result<Vec<String>, String> {
    let client = reqwest::Client::new();
    let models_url = format!("{}/models", base_url.trim().trim_end_matches('/'));

    tracing::info!("Fetching models from: {}", models_url);

    let timeout_duration = std::time::Duration::from_secs(timeout_secs.unwrap_or(FETCH_MODELS_DEFAULT_TIMEOUT_SECS));
    let response = client
        .get(&models_url)
        .header("Authorization", format!("Bearer {}", api_key))
        .timeout(timeout_duration)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch models: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = match response.text().await {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!("Failed to read error response body: {}", e);
                String::new()
            }
        };
        tracing::error!("API request failed: {} - {}", status, body);
        return Err(format!("API request failed with status: {}", status));
    }

    let models_data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    tracing::debug!("Received response: {:?}", models_data);

    // Try different formats in order of preference
    let models = if let Some(data) = models_data.get("data") {
        crate::providers::model_formats::extract_openai_format(data)?
    } else if models_data.is_array() {
        crate::providers::model_formats::extract_array_format(&models_data)?
    } else if models_data.get("models").is_some() {
        crate::providers::model_formats::extract_models_obj_format(&models_data)?
    } else {
        return Err(
            "Unsupported API response format. Expected OpenAI format with 'data' array or direct array"
                .to_string(),
        );
    };

    tracing::info!("Extracted {} models", models.len());
    Ok(models)
}

#[tauri::command]
pub async fn list_providers(
    state: tauri::State<'_, SharedState>,
) -> Result<Vec<serde_json::Value>, String> {
    let s = state.read().await;
    Ok(s.providers
        .iter()
        .map(|p| {
            serde_json::json!({
                "id": p.id,
                "name": p.name,
                "base_url": p.base_url,
                "models": p.models,
            })
        })
        .collect())
}

