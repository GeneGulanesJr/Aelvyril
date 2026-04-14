use serde::{Deserialize, Serialize};

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
    providers.iter().find(|p| p.models.iter().any(|m| model.starts_with(m)))
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
