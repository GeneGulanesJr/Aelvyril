// Helper: Extract models from OpenAI format { "data": [{ "id": "model-name" }] }
pub fn extract_openai_format(data: &serde_json::Value) -> Result<Vec<String>, String> {
    let arr = data
        .as_array()
        .ok_or("Invalid OpenAI format: data is not an array".to_string())?;
    Ok(arr
        .iter()
        .filter_map(|m| m.get("id")?.as_str().map(|s| s.to_string()))
        .collect())
}

// Helper: Extract models from direct string array
pub fn extract_array_format(data: &serde_json::Value) -> Result<Vec<String>, String> {
    let arr = data.as_array().ok_or("Invalid array format".to_string())?;
    Ok(arr
        .iter()
        .filter_map(|m| m.as_str().map(|s| s.to_string()))
        .collect())
}

// Helper: Extract models from { "models": ["model1", "model2"] }
pub fn extract_models_obj_format(data: &serde_json::Value) -> Result<Vec<String>, String> {
    let models_obj = data
        .get("models")
        .ok_or("Models key not found".to_string())?;
    let arr = models_obj
        .as_array()
        .ok_or("Invalid models format: models is not an array".to_string())?;
    Ok(arr
        .iter()
        .filter_map(|m| m.as_str().map(|s| s.to_string()))
        .collect())
}

