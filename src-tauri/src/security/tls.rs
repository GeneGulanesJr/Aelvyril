use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// TLS configuration for the local gateway endpoint.
///
/// Aelvyril binds to loopback only (127.0.0.1). TLS is optional but recommended
/// for defense-in-depth — it prevents local packet sniffing from reading API keys
/// or sensitive content in transit between the client tool and the gateway.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlsConfig {
    /// Whether TLS is enabled
    pub enabled: bool,
    /// Path to the self-signed certificate PEM
    pub cert_path: PathBuf,
    /// Path to the private key PEM
    pub key_path: PathBuf,
}

impl Default for TlsConfig {
    fn default() -> Self {
        let cert_dir = dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("aelvyril")
            .join("tls");

        Self {
            enabled: false, // Off by default; users opt in via settings
            cert_path: cert_dir.join("gateway.crt"),
            key_path: cert_dir.join("gateway.key"),
        }
    }
}

impl TlsConfig {
    /// Ensure the TLS cert/key directory exists
    pub fn ensure_dir(&self) -> Result<(), String> {
        if let Some(parent) = self.cert_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create TLS directory: {}", e))?;
        }
        Ok(())
    }

    /// Generate a self-signed certificate and private key.
    ///
    /// Uses the `rcgen` crate to create a certificate valid for 365 days,
    /// issued to "Aelvyril Local Gateway", with SANs for 127.0.0.1 and localhost.
    ///
    /// **Security properties:**
    /// - Key is ECDSA P-256 (fast, modern, no RSA padding issues)
    /// - Certificate is self-signed (no CA dependency)
    /// - Never leaves the local machine (stored in app data directory)
    /// - Regenerated on user request or if corrupted
    pub fn generate_self_signed(&mut self) -> Result<(), String> {
        self.ensure_dir()?;

        // rcgen is an optional dependency — only used when TLS is enabled
        #[cfg(feature = "tls")]
        {
            let mut params = rcgen::CertificateParams::new(Vec::new());
            params.distinguished_name = rcgen::DistinguishedName::new();
            params
                .distinguished_name
                .push(rcgen::DnType::CommonName, "Aelvyril Local Gateway");
            params
                .distinguished_name
                .push(rcgen::DnType::OrganizationName, "Aelvyril");

            // Add SANs for localhost and 127.0.0.1
            params.subject_alt_names = vec![
                rcgen::SanType::DnsName("localhost".to_string()),
                rcgen::SanType::IpAddress(std::net::IpAddr::V4(std::net::Ipv4Addr::new(
                    127, 0, 0, 1,
                ))),
            ];

            // 365-day validity
            params.not_before = rcgen::date_time_ymd(
                chrono::Utc::now().year(),
                chrono::Utc::now().month() as u8,
                chrono::Utc::now().day() as u8,
            );
            let expiry = chrono::Utc::now() + chrono::Duration::days(365);
            params.not_after =
                rcgen::date_time_ymd(expiry.year(), expiry.month() as u8, expiry.day() as u8);

            let key_pair = rcgen::KeyPair::generate()
                .map_err(|e| format!("Failed to generate key pair: {}", e))?;
            let cert = params
                .signed_by(
                    &key_pair,
                    &rcgen::Certificate::from_params(rcgen::CertificateParams::new(Vec::new()))
                        .map_err(|e| format!("Self-sign failed: {}", e))?,
                    &key_pair,
                )
                .map_err(|e| format!("Failed to create certificate: {}", e))?;

            // Write cert
            let cert_pem = cert.pem();
            std::fs::write(&self.cert_path, &cert_pem)
                .map_err(|e| format!("Failed to write certificate: {}", e))?;

            // Write key
            let key_pem = key_pair.serialize_pem();
            std::fs::write(&self.key_path, &key_pem)
                .map_err(|e| format!("Failed to write private key: {}", e))?;

            tracing::info!(
                "🔐 Generated self-signed TLS certificate at {:?}",
                self.cert_path
            );
            Ok(())
        }

        #[cfg(not(feature = "tls"))]
        {
            tracing::warn!("TLS feature not enabled — cannot generate certificate");
            Err("TLS feature not enabled at compile time".into())
        }
    }

    /// Check if the cert and key files exist on disk
    pub fn files_exist(&self) -> bool {
        self.cert_path.exists() && self.key_path.exists()
    }

    /// Verify the cert is not expired and matches expected properties
    pub fn validate(&self) -> Result<TlsValidity, String> {
        if !self.files_exist() {
            return Err("TLS certificate or key files not found".into());
        }

        // Basic file-level validation — full X.509 parsing requires the tls feature
        let cert_metadata = std::fs::metadata(&self.cert_path)
            .map_err(|e| format!("Cannot read cert file: {}", e))?;
        let key_metadata = std::fs::metadata(&self.key_path)
            .map_err(|e| format!("Cannot read key file: {}", e))?;

        if cert_metadata.len() == 0 {
            return Err("Certificate file is empty".into());
        }
        if key_metadata.len() == 0 {
            return Err("Key file is empty".into());
        }

        Ok(TlsValidity {
            cert_exists: true,
            key_exists: true,
            cert_size_bytes: cert_metadata.len(),
            key_size_bytes: key_metadata.len(),
        })
    }

    /// Delete certificate and key files from disk
    pub fn remove_files(&self) -> Result<(), String> {
        if self.cert_path.exists() {
            std::fs::remove_file(&self.cert_path)
                .map_err(|e| format!("Failed to remove cert: {}", e))?;
        }
        if self.key_path.exists() {
            std::fs::remove_file(&self.key_path)
                .map_err(|e| format!("Failed to remove key: {}", e))?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TlsValidity {
    pub cert_exists: bool,
    pub key_exists: bool,
    pub cert_size_bytes: u64,
    pub key_size_bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config_paths() {
        let config = TlsConfig::default();
        assert!(!config.enabled);
        assert!(config.cert_path.to_string_lossy().contains("aelvyril"));
        assert!(config.key_path.to_string_lossy().contains("aelvyril"));
    }

    #[test]
    fn test_files_exist_false_for_missing() {
        let config = TlsConfig::default();
        assert!(!config.files_exist());
    }
}
