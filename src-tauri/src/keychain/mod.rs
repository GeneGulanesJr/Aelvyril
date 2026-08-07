//! OS keychain wrappers for storing the gateway key and per-provider API keys.
//!
//! In environments without a usable OS keyring (CI containers, headless tests),
//! a provider key may instead be supplied via the environment variable
//! `AELVYRIL_KEY_<PROVIDER>`, where `<PROVIDER>` is the provider name uppercased
//! with spaces and hyphens replaced by `_` (e.g. `"BenchmarkDummy"` →
//! `AELVYRIL_KEY_BENCHMARKDUMMY`). This override is consulted *before* the
//! OS keyring lookup and takes precedence.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum KeychainError {
    #[error("Keychain operation failed: {0}")]
    Operation(String),
    #[error("Key not found")]
    NotFound,
}

impl From<keyring::Error> for KeychainError {
    fn from(e: keyring::Error) -> Self {
        match e {
            keyring::Error::NoEntry => KeychainError::NotFound,
            _ => KeychainError::Operation(e.to_string()),
        }
    }
}

const SERVICE_NAME: &str = "aelvyril";
const GATEWAY_KEY_ID: &str = "gateway-key";

/// Store the gateway API key in OS keychain
pub fn store_gateway_key(key: &str) -> Result<(), KeychainError> {
    let entry = keyring::Entry::new(SERVICE_NAME, GATEWAY_KEY_ID)?;
    entry.set_password(key)?;
    Ok(())
}

/// Retrieve the gateway API key from OS keychain
pub fn get_gateway_key() -> Result<String, KeychainError> {
    let entry = keyring::Entry::new(SERVICE_NAME, GATEWAY_KEY_ID)?;
    Ok(entry.get_password()?)
}

/// Delete the gateway API key from OS keychain
pub fn delete_gateway_key() -> Result<(), KeychainError> {
    let entry = keyring::Entry::new(SERVICE_NAME, GATEWAY_KEY_ID)?;
    entry.delete_credential()?;
    Ok(())
}

/// Store a provider API key in OS keychain
pub fn store_provider_key(provider_name: &str, key: &str) -> Result<(), KeychainError> {
    let entry = keyring::Entry::new(
        SERVICE_NAME,
        &format!("provider-{}", provider_name.to_lowercase()),
    )?;
    entry.set_password(key)?;
    Ok(())
}

/// Retrieve a provider API key from OS keychain
///
/// If the environment variable `AELVYRIL_KEY_<PROVIDER>` (with `<PROVIDER>`
/// derived from `provider_name` by uppercasing and replacing spaces/hyphens
/// with `_`) is set, it is returned immediately without touching the keyring.
/// This is the primary path for CI and in-process tests.
pub fn get_provider_key(provider_name: &str) -> Result<String, KeychainError> {
    let env_name = format!(
        "AELVYRIL_KEY_{}",
        provider_name.to_uppercase().replace(' ', "_").replace('-', "_")
    );
    if let Ok(val) = std::env::var(&env_name) {
        return Ok(val);
    }

    let entry = keyring::Entry::new(
        SERVICE_NAME,
        &format!("provider-{}", provider_name.to_lowercase()),
    )?;
    Ok(entry.get_password()?)
}

/// Delete a provider API key from OS keychain
pub fn delete_provider_key(provider_name: &str) -> Result<(), KeychainError> {
    let entry = keyring::Entry::new(
        SERVICE_NAME,
        &format!("provider-{}", provider_name.to_lowercase()),
    )?;
    entry.delete_credential()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore]
    fn test_gateway_key_round_trip() {
        let test_key = "test-gateway-key-12345";
        store_gateway_key(test_key).expect("Failed to store key");
        let retrieved = get_gateway_key().expect("Failed to get key");
        assert_eq!(retrieved, test_key);
        delete_gateway_key().expect("Failed to delete key");
    }

    #[test]
    #[ignore]
    fn test_provider_key_round_trip() {
        let test_key = "sk-test-provider-key-12345";
        store_provider_key("TestProvider", test_key).expect("Failed to store key");
        let retrieved = get_provider_key("TestProvider").expect("Failed to get key");
        assert_eq!(retrieved, test_key);
        delete_provider_key("TestProvider").expect("Failed to delete key");
    }

    #[test]
    #[ignore]
    fn test_key_not_found() {
        let result = get_provider_key("NonExistentProvider999");
        assert!(result.is_err());
    }

    /// The env-var override must short-circuit the OS keyring lookup so tests and
    /// CI can supply provider keys without a Secret Service daemon. This test does
    /// NOT depend on keyring.
    #[test]
    fn test_get_provider_key_env_override() {
        // Use a unique value so other parallel tests cannot poison the assertion.
        let unique = std::process::id();
        let value = format!("test-key-{}", unique);
        std::env::set_var("AELVYRIL_KEY_BENCHMARKDUMMY", &value);
        let result = get_provider_key("BenchmarkDummy");
        assert_eq!(result.expect("env override should be returned"), value);
        std::env::remove_var("AELVYRIL_KEY_BENCHMARKDUMMY");
    }
}
