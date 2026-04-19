use serde::{Deserialize, Serialize};

const GATEWAY_BIND_ADDR_ENV: &str = "AELVYRIL_GATEWAY_BIND";
const GATEWAY_PORT_ENV: &str = "AELVYRIL_GATEWAY_PORT";

/// Default gateway port (fallback when AELVYRIL_GATEWAY_PORT is not set)
const DEFAULT_GATEWAY_PORT: u16 = 4242;

/// Default session timeout in minutes
const DEFAULT_SESSION_TIMEOUT_MINUTES: u32 = 30;

pub mod store;

/// Persistent app settings (saved to disk)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
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
    /// Gateway bind address (can be configured via AELVYRIL_GATEWAY_BIND env var)
    pub gateway_bind_address: String,
    /// Enable individual PII recognizers
    pub enabled_recognizers: Vec<String>,
    /// Detection confidence threshold (0.0–1.0)
    pub confidence_threshold: f64,
    /// Rate limit: max requests per minute (per client)
    pub rate_limit_max_requests_per_minute: u32,
    /// Rate limit: max requests per hour (per client)
    pub rate_limit_max_requests_per_hour: u32,
    /// Rate limit: max concurrent requests (global)
    pub rate_limit_max_concurrent_requests: u32,
}

impl Default for AppSettings {
    fn default() -> Self {
        let gateway_bind_address =
            std::env::var(GATEWAY_BIND_ADDR_ENV).unwrap_or_else(|_| "127.0.0.1".to_string());
        let gateway_port: u16 = std::env::var(GATEWAY_PORT_ENV)
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(DEFAULT_GATEWAY_PORT);
        let rate_limit_defaults = crate::security::rate_limit::RateLimitConfig::default();

        Self {
            launch_at_login: false,
            minimize_to_tray: true,
            show_notifications: true,
            clipboard_monitoring: false,
            session_timeout_minutes: DEFAULT_SESSION_TIMEOUT_MINUTES,
            gateway_port,
            gateway_bind_address,
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
            rate_limit_max_requests_per_minute: rate_limit_defaults.max_requests_per_minute,
            rate_limit_max_requests_per_hour: rate_limit_defaults.max_requests_per_hour,
            rate_limit_max_concurrent_requests: rate_limit_defaults.max_concurrent_requests,
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
