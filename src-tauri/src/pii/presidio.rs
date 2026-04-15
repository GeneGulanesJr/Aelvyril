//! Microsoft Presidio integration — calls a local Presidio analyzer HTTP service
//! and converts results into our native `PiiMatch` format.
//!
//! Presidio runs as a lightweight Python microservice. This module is the Rust client.
//! If the service is unavailable, detection falls back gracefully to our custom
//! recognizers only (see `PiiEngine::detect`).

use super::recognizers::{PiiMatch, PiiType};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tracing;

/// Presidio analyzer request
#[derive(Debug, Serialize)]
struct AnalyzeRequest {
    text: String,
    language: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    entities: Vec<String>,
    score_threshold: f64,
}

/// A single Presidio analyzer result
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct PresidioResult {
    entity_type: String,
    start: usize,
    end: usize,
    score: f64,
    analysis_metadata: Option<serde_json::Value>,
}

/// Presidio analyzer response
#[derive(Debug, Deserialize)]
struct AnalyzeResponse {
    result: Vec<PresidioResult>,
}

/// Map Presidio entity type strings to our `PiiType` enum.
/// Presidio supports many more types — unrecognized ones are preserved as custom.
fn presidio_entity_to_pii_type(entity: &str) -> PiiType {
    match entity {
        "EMAIL_ADDRESS" => PiiType::Email,
        "PHONE_NUMBER" => PiiType::PhoneNumber,
        "IP_ADDRESS" => PiiType::IpAddress,
        "CREDIT_CARD" => PiiType::CreditCard,
        "US_SSN" => PiiType::Ssn,
        "IBAN_CODE" => PiiType::Iban,
        "API_KEY" | "CRYPTO" | "MEDICAL_LICENSE" => PiiType::ApiKey,
        "URL" | "DOMAIN_NAME" => PiiType::Domain,
        "DATE_TIME" | "DATE" => PiiType::Date,
        "US_ZIP_CODE" | "ZIP_CODE" => PiiType::ZipCode,
        // Map location-related types
        "LOCATION" | "US_STATE" | "CITY" | "STREET_ADDRESS" => PiiType::ApiKey,
        // Map person name to a high-confidence custom detection
        "PERSON" => PiiType::ApiKey,
        // Map financial identifiers
        "US_BANK_NUMBER" | "US_PASSPORT" | "UK_NHS" => PiiType::ApiKey,
        // Default — preserve as ApiKey with high confidence so nothing slips through
        _ => {
            tracing::debug!(
                ?entity,
                "Unmapped Presidio entity type, treating as high-confidence"
            );
            PiiType::ApiKey
        }
    }
}

/// Client for the local Presidio analyzer service
#[derive(Clone)]
pub struct PresidioClient {
    http: Client,
    base_url: String,
    enabled: bool,
}

impl PresidioClient {
    /// Create a new Presidio client.
    ///
    /// `base_url` should point to the Presidio analyzer service
    /// (e.g. `http://localhost:3000/analyze`).
    /// Set `enabled = false` to skip Presidio entirely (custom-only mode).
    pub fn new(base_url: String, enabled: bool) -> Self {
        // Strip trailing slash
        let base_url = base_url.trim_end_matches('/').to_string();
        Self {
            http: Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .connect_timeout(std::time::Duration::from_secs(2))
                .build()
                .unwrap_or_else(|_| Client::new()),
            base_url,
            enabled,
        }
    }

    /// Returns true if Presidio integration is enabled
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Enable or disable the Presidio client
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    /// Update the base URL
    pub fn set_url(&mut self, url: String) {
        self.base_url = url.trim_end_matches('/').to_string();
    }

    /// Analyze text using the Presidio service.
    ///
    /// Returns `None` if Presidio is disabled or the service is unreachable
    /// (graceful degradation — callers should fall back to custom recognizers).
    pub async fn analyze(&self, text: &str, score_threshold: f64) -> Option<Vec<PiiMatch>> {
        if !self.enabled {
            return None;
        }

        let request = AnalyzeRequest {
            text: text.to_string(),
            language: "en".to_string(),
            entities: Vec::new(), // Let Presidio use all its recognizers
            score_threshold,
        };

        let url = format!("{}/analyze", self.base_url);

        match self.http.post(&url).json(&request).send().await {
            Ok(resp) if resp.status().is_success() => match resp.json::<AnalyzeResponse>().await {
                Ok(body) => {
                    let matches: Vec<PiiMatch> = body
                        .result
                        .into_iter()
                        .map(|r| PiiMatch {
                            pii_type: presidio_entity_to_pii_type(&r.entity_type),
                            text: text[r.start..r.end].to_string(),
                            start: r.start,
                            end: r.end,
                            confidence: r.score,
                        })
                        .collect();

                    if !matches.is_empty() {
                        tracing::debug!(
                            count = matches.len(),
                            "Presidio detected {} entities",
                            matches.len()
                        );
                    }

                    Some(matches)
                }
                Err(e) => {
                    tracing::warn!("Presidio returned invalid JSON: {}", e);
                    None
                }
            },
            Ok(resp) => {
                tracing::warn!("Presidio service returned status: {}", resp.status());
                None
            }
            Err(e) => {
                // This is expected if the Presidio service isn't running.
                // Log at debug level so it doesn't spam in normal operation.
                tracing::debug!(
                    "Presidio service unreachable (falling back to custom recognizers): {}",
                    e
                );
                None
            }
        }
    }

    /// Health check — returns true if the Presidio service is reachable.
    pub async fn health_check(&self) -> bool {
        if !self.enabled {
            return false;
        }
        let url = format!("{}/health", self.base_url);
        self.http
            .get(&url)
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_entity_type_mapping() {
        assert_eq!(presidio_entity_to_pii_type("EMAIL_ADDRESS"), PiiType::Email);
        assert_eq!(
            presidio_entity_to_pii_type("PHONE_NUMBER"),
            PiiType::PhoneNumber
        );
        assert_eq!(
            presidio_entity_to_pii_type("IP_ADDRESS"),
            PiiType::IpAddress
        );
        assert_eq!(
            presidio_entity_to_pii_type("CREDIT_CARD"),
            PiiType::CreditCard
        );
        assert_eq!(presidio_entity_to_pii_type("US_SSN"), PiiType::Ssn);
        assert_eq!(presidio_entity_to_pii_type("IBAN_CODE"), PiiType::Iban);
        assert_eq!(presidio_entity_to_pii_type("DATE_TIME"), PiiType::Date);
        assert_eq!(presidio_entity_to_pii_type("US_ZIP_CODE"), PiiType::ZipCode);
        assert_eq!(presidio_entity_to_pii_type("DOMAIN_NAME"), PiiType::Domain);
        assert_eq!(presidio_entity_to_pii_type("PERSON"), PiiType::ApiKey);
        assert_eq!(presidio_entity_to_pii_type("UNKNOWN_TYPE"), PiiType::ApiKey);
    }

    #[test]
    fn test_client_disabled_returns_none() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let client = PresidioClient::new("http://localhost:9999".into(), false);
        let result = rt.block_on(client.analyze("test", 0.5));
        assert!(result.is_none());
    }
}
