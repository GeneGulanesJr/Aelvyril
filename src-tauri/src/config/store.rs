use std::path::PathBuf;

use super::AppSettings;

fn settings_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("aelvyril")
        .join("settings.json")
}

pub fn load_settings() -> AppSettings {
    let path = settings_path();
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return AppSettings::default(),
    };

    match serde_json::from_str::<AppSettings>(&contents) {
        Ok(settings) => settings,
        Err(e) => {
            tracing::warn!("Failed to parse settings at {:?}: {}", path, e);
            AppSettings::default()
        }
    }
}

pub fn save_settings(settings: &AppSettings) -> Result<(), String> {
    let path = settings_path();

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create settings directory: {}", e))?;
    }

    let json =
        serde_json::to_string_pretty(settings).map_err(|e| format!("Failed to serialize settings: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write settings: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_settings_path_is_deterministic() {
        let p1 = settings_path();
        let p2 = settings_path();
        assert_eq!(p1, p2);
    }
}

