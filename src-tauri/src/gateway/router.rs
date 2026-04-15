use crate::config::{self, ProviderConfig};
use crate::keychain;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RouterError {
    #[error("No provider configured for model: {0}")]
    NoProvider(String),
    #[error("Provider '{0}' has no API key stored in keychain")]
    NoApiKey(String),
    #[error("Failed to retrieve API key: {0}")]
    KeychainError(#[from] keychain::KeychainError),
}

/// Route a model name to the correct upstream provider
pub fn resolve_provider<'a>(
    providers: &'a [ProviderConfig],
    model: &str,
) -> Result<&'a ProviderConfig, RouterError> {
    config::find_provider_for_model(providers, model)
        .ok_or_else(|| RouterError::NoProvider(model.to_string()))
}

/// Get the API key for a provider from the OS keychain
pub fn get_provider_api_key(provider_name: &str) -> Result<String, RouterError> {
    match keychain::get_provider_key(provider_name) {
        Ok(k) => Ok(k),
        Err(keychain::KeychainError::NotFound) => {
            Err(RouterError::NoApiKey(provider_name.to_string()))
        }
        Err(e) => Err(RouterError::KeychainError(e)),
    }
}

/// Build the upstream URL for a chat completions request
pub fn build_upstream_url(provider: &ProviderConfig) -> String {
    let base = provider.base_url.trim_end_matches('/');
    // Anthropic uses a different endpoint structure
    if provider.name.to_lowercase().contains("anthropic") {
        format!("{}/messages", base)
    } else {
        format!("{}/chat/completions", base)
    }
}

/// Build the upstream URL for non-chat endpoints (passthrough).
/// `path` is the remainder after `/v1/` (with or without a leading slash).
pub fn build_passthrough_url(provider: &ProviderConfig, path: &str) -> String {
    let base = provider.base_url.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    format!("{}/{}", base, path)
}

/// Find the next available provider for failover
pub fn find_failover_provider<'a>(
    providers: &'a [ProviderConfig],
    failed_provider: &str,
    model: &str,
) -> Option<&'a ProviderConfig> {
    // Try to find another provider that supports this model
    providers
        .iter()
        .find(|p| p.name != failed_provider && p.models.iter().any(|m| model.starts_with(m)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_openai() {
        let providers = config::default_providers();
        let provider = resolve_provider(&providers, "gpt-4o").unwrap();
        assert_eq!(provider.name, "OpenAI");
    }

    #[test]
    fn test_resolve_anthropic() {
        let providers = config::default_providers();
        let provider = resolve_provider(&providers, "claude-sonnet-4").unwrap();
        assert_eq!(provider.name, "Anthropic");
    }

    #[test]
    fn test_resolve_unknown_model() {
        let providers = config::default_providers();
        let result = resolve_provider(&providers, "llama-3-70b");
        assert!(result.is_err());
    }

    #[test]
    fn test_build_upstream_url_openai() {
        let provider = ProviderConfig {
            id: "test".into(),
            name: "OpenAI".into(),
            base_url: "https://api.openai.com/v1".into(),
            models: vec![],
        };
        assert_eq!(
            build_upstream_url(&provider),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn test_build_upstream_url_anthropic() {
        let provider = ProviderConfig {
            id: "test".into(),
            name: "Anthropic".into(),
            base_url: "https://api.anthropic.com/v1".into(),
            models: vec![],
        };
        assert_eq!(
            build_upstream_url(&provider),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn test_build_passthrough_url() {
        let provider = ProviderConfig {
            id: "test".into(),
            name: "OpenAI".into(),
            base_url: "https://api.openai.com/v1/".into(),
            models: vec![],
        };
        assert_eq!(
            build_passthrough_url(&provider, "embeddings"),
            "https://api.openai.com/v1/embeddings"
        );
        assert_eq!(
            build_passthrough_url(&provider, "/models"),
            "https://api.openai.com/v1/models"
        );
    }

    #[test]
    fn test_find_failover() {
        let providers = vec![
            ProviderConfig {
                id: "1".into(),
                name: "OpenAI".into(),
                base_url: "https://api.openai.com/v1".into(),
                models: vec!["gpt-4o".into()],
            },
            ProviderConfig {
                id: "2".into(),
                name: "OpenAI-Backup".into(),
                base_url: "https://backup.openai.com/v1".into(),
                models: vec!["gpt-4o".into()],
            },
        ];
        let failover = find_failover_provider(&providers, "OpenAI", "gpt-4o");
        assert!(failover.is_some());
        assert_eq!(failover.unwrap().name, "OpenAI-Backup");
    }
}
