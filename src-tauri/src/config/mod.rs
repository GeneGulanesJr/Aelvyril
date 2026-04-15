use serde::{Deserialize, Serialize};

/// Persistent app settings (saved to disk)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    /// Launch at system startup
    pub launch_at_login: bool,
    /// Minimize to system tray on close
    pub minimize_to_tray: bool,
    /// Show notifications for PII detection
    pub show_notifications: bool,
    /// Monitor clipboard for PII
    pub clipboard_monitoring: bool,
    /// Session timeout in minutes
    pub session_timeout_minutes: u32,
    /// Gateway port
    pub gateway_port: u16,
    /// Enable individual PII recognizers
    pub enabled_recognizers: Vec<String>,
    /// Detection confidence threshold (0.0–1.0)
    pub confidence_threshold: f64,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            launch_at_login: false,
            minimize_to_tray: true,
            show_notifications: true,
            clipboard_monitoring: false,
            session_timeout_minutes: 30,
            gateway_port: 4242,
            enabled_recognizers: vec![
                "email".into(),
                "phone".into(),
                "ip_address".into(),
                "api_key".into(),
                "credit_card".into(),
                "ssn".into(),
                "domain".into(),
                "iban".into(),
            ],
            confidence_threshold: 0.5,
        }
    }
}

/// Configuration for an upstream provider
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub base_url: String,
    /// Model names that route to this provider
    pub models: Vec<String>,
}

/// Default well-known providers for quick setup
pub fn default_providers() -> Vec<ProviderConfig> {
    vec![
        ProviderConfig {
            id: "openai-default".into(),
            name: "OpenAI".into(),
            base_url: "https://api.openai.com/v1".into(),
            models: vec![
                "gpt-4o".into(),
                "gpt-4o-mini".into(),
                "gpt-4-turbo".into(),
                "gpt-4".into(),
                "gpt-3.5-turbo".into(),
                "o1".into(),
                "o1-mini".into(),
                "o3-mini".into(),
            ],
        },
        ProviderConfig {
            id: "anthropic-default".into(),
            name: "Anthropic".into(),
            base_url: "https://api.anthropic.com/v1".into(),
            models: vec![
                "claude-sonnet-4-20250514".into(),
                "claude-sonnet-4".into(),
                "claude-opus-4-20250514".into(),
                "claude-opus-4".into(),
                "claude-3.5-sonnet".into(),
                "claude-3.5-haiku".into(),
                "claude-3-opus".into(),
            ],
        },
    ]
}

/// Find which provider handles a given model
pub fn find_provider_for_model<'a>(
    providers: &'a [ProviderConfig],
    model: &str,
) -> Option<&'a ProviderConfig> {
    providers
        .iter()
        .find(|p| p.models.iter().any(|m| model.starts_with(m)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_provider_openai() {
        let providers = default_providers();
        let provider = find_provider_for_model(&providers, "gpt-4o");
        assert!(provider.is_some());
        assert_eq!(provider.unwrap().name, "OpenAI");
    }

    #[test]
    fn test_find_provider_anthropic() {
        let providers = default_providers();
        let provider = find_provider_for_model(&providers, "claude-sonnet-4-20250514");
        assert!(provider.is_some());
        assert_eq!(provider.unwrap().name, "Anthropic");
    }

    #[test]
    fn test_find_provider_unknown() {
        let providers = default_providers();
        let provider = find_provider_for_model(&providers, "llama-3-70b");
        assert!(provider.is_none());
    }
}
