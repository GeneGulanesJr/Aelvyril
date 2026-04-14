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
pub fn get_provider_key(provider_name: &str) -> Result<String, KeychainError> {
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
}
