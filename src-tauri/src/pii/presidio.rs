//! Microsoft Presidio integration — calls a local Presidio analyzer HTTP service
//! and converts results into our native `PiiMatch` format.
//!
//! Presidio runs as a lightweight Python microservice. This module is the Rust client.
//! If the service is unavailable, detection falls back gracefully to our custom
//! recognizers only (see `PiiEngine::detect`).

use super::recognizers::{PiiMatch, PiiType};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tracing;

// ── HTTP Status Code Constants ────────────────────────────────────────────────

const HTTP_OK: u16 = 200;
const HTTP_BAD_REQUEST: u16 = 400;
const HTTP_SERVICE_UNAVAILABLE: u16 = 503;
const HTTP_INTERNAL_ERROR: u16 = 500;

// ── Retry / Timeout Defaults ──────────────────────────────────────────────────

const DEFAULT_REQUEST_TIMEOUT_SECS: u64 = 5;
const DEFAULT_CONNECT_TIMEOUT_SECS: u64 = 2;
const DEFAULT_HEALTH_CHECK_TIMEOUT_SECS: u64 = 3;
const DEFAULT_MAX_RETRIES: u32 = 2;
const DEFAULT_RETRY_BASE_DELAY_MS: u64 = 100;

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

// ── Structured Error Types ─────────────────────────────────────────────────────

/// Categorised errors from the Presidio client.
///
/// Each variant carries enough context for the caller to decide on fallback
/// behaviour and for diagnostic logging.
#[derive(Debug, Clone)]
pub enum PresidioError {
    /// The client is disabled (intentional — not an error per se).
    Disabled,
    /// The Presidio Python service was unreachable or returned a non-success status.
    ServiceUnavailable {
        status: Option<u16>,
        detail: String,
    },
    /// The service returned a response that could not be deserialised.
    InvalidResponse(String),
    /// The request was rejected as malformed.
    BadRequest(String),
    /// The service reported an internal error (5xx).
    InternalError { status: u16, detail: String },
}

impl std::fmt::Display for PresidioError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disabled => write!(f, "Presidio client is disabled"),
            Self::ServiceUnavailable { status, detail } => {
                write!(f, "Presidio service unavailable (status={:?}): {}", status, detail)
            }
            Self::InvalidResponse(msg) => write!(f, "Presidio returned invalid response: {}", msg),
            Self::BadRequest(msg) => write!(f, "Presidio bad request: {}", msg),
            Self::InternalError { status, detail } => {
                write!(f, "Presidio internal error (status={}): {}", status, detail)
            }
        }
    }
}

impl std::error::Error for PresidioError {}

/// Map Presidio entity type strings to our `PiiType` enum.
/// Presidio supports many more types — unrecognized ones are preserved as custom.
///
/// The PiiType Display impl emits UPPER_SNAKE_CASE strings, matching the
/// gold annotation namespace used by all benchmark datasets. This ensures
/// entity type comparison in scoring is a simple string equality check.
fn presidio_entity_to_pii_type(entity: &str) -> PiiType {
    match entity {
        "EMAIL_ADDRESS" => PiiType::Email,
        "PHONE_NUMBER" => PiiType::PhoneNumber,
        "IP_ADDRESS" => PiiType::IpAddress,
        "CREDIT_CARD" => PiiType::CreditCard,
        "US_SSN" => PiiType::Ssn,
        "IBAN_CODE" => PiiType::Iban,
        "API_KEY" | "CRYPTO" | "MEDICAL_LICENSE" => PiiType::ApiKey,
        "URL" => PiiType::Domain,
        "DOMAIN_NAME" => PiiType::Domain,
        "DATE_TIME" => PiiType::Date,
        "DATE" => PiiType::Date,
        "US_ZIP_CODE" | "ZIP_CODE" => PiiType::ZipCode,
        // Fine-grained NER types
        "CITY" => PiiType::City,
        "US_STATE" => PiiType::UsState,
        "STREET_ADDRESS" => PiiType::StreetAddress,
        "COUNTRY" => PiiType::Country,
        "NATIONALITY" => PiiType::Nationality,
        "TITLE" => PiiType::Title,
        "MEDICAL_RECORD" => PiiType::MedicalRecord,
        "AGE" => PiiType::Age,
        "SWIFT_CODE" => PiiType::SwiftCode,
        "US_BANK_NUMBER" => PiiType::UsBankNumber,
        "US_PASSPORT" => PiiType::UsPassport,
        "US_DRIVER_LICENSE" => PiiType::UsDriverLicense,
        // Generic NER types
        "PERSON" | "PER" => PiiType::Person,
        "LOCATION" | "LOC" => PiiType::Location,
        "ORGANIZATION" | "ORG" | "NRP" => PiiType::Organization,
        // Catch-all for any unmapped Presidio type — preserve verbatim
        _ => {
            tracing::debug!(
                ?entity,
                "Unmapped Presidio entity type, preserving as Custom"
            );
            PiiType::Custom(entity.to_string())
        }
    }
}

/// Client for the local Presidio analyzer service
#[derive(Clone)]
pub struct PresidioClient {
    http: Client,
    base_url: String,
    enabled: bool,
    /// Maximum number of retries for transient failures (0 = no retries).
    max_retries: u32,
    /// Base delay in ms for exponential back-off between retries.
    retry_base_delay: Duration,
}

impl PresidioClient {
    /// Create a new Presidio client with default retry settings.
    ///
    /// `base_url` should point to the Presidio analyzer service root
    /// (e.g. `http://localhost:3000`).
    /// Set `enabled = false` to skip Presidio entirely (custom-only mode).
    pub fn new(base_url: String, enabled: bool) -> Self {
        Self::builder(base_url, enabled).build()
    }

    /// Create a builder for custom configuration.
    pub fn builder(base_url: String, enabled: bool) -> PresidioClientBuilder {
        PresidioClientBuilder {
            base_url,
            enabled,
            request_timeout: Duration::from_secs(DEFAULT_REQUEST_TIMEOUT_SECS),
            connect_timeout: Duration::from_secs(DEFAULT_CONNECT_TIMEOUT_SECS),
            health_check_timeout: Duration::from_secs(DEFAULT_HEALTH_CHECK_TIMEOUT_SECS),
            max_retries: DEFAULT_MAX_RETRIES,
            retry_base_delay: Duration::from_millis(DEFAULT_RETRY_BASE_DELAY_MS),
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

    /// Sleep for an exponential back-off duration.
    async fn retry_delay(&self, attempt: u32) {
        if attempt == 0 {
            return;
        }
        let delay = self.retry_base_delay * 2u32.saturating_pow(attempt - 1);
        tokio::time::sleep(delay).await;
    }

    /// Classify an HTTP status code into a `PresidioError`.
    fn classify_status(&self, status: reqwest::StatusCode, body: &str) -> PresidioError {
        let code: u16 = status.as_u16();
        match code {
            HTTP_BAD_REQUEST => PresidioError::BadRequest(body.to_string()),
            HTTP_SERVICE_UNAVAILABLE => PresidioError::ServiceUnavailable {
                status: Some(code),
                detail: body.to_string(),
            },
            s if s >= HTTP_INTERNAL_ERROR => PresidioError::InternalError {
                status: code,
                detail: body.to_string(),
            },
            _ => PresidioError::ServiceUnavailable {
                status: Some(code),
                detail: body.to_string(),
            },
        }
    }

    /// Whether a given failure is worth retrying (transient / server-side).
    fn is_retryable(&self, err: &PresidioError) -> bool {
        matches!(
            err,
            PresidioError::ServiceUnavailable { .. } | PresidioError::InternalError { .. }
        )
    }

    /// Analyse text using the Presidio service.
    ///
    /// Returns `Err(PresidioError)` for diagnosable failures and `Ok(None)` when
    /// the client is disabled. Callers that prefer the `Option` interface can use
    /// [`analyze`] which maps errors to `None`.
    pub async fn analyze_with_error(
        &self,
        text: &str,
        score_threshold: f64,
    ) -> Result<Option<Vec<PiiMatch>>, PresidioError> {
        if !self.enabled {
            return Ok(None);
        }

        let request = AnalyzeRequest {
            text: text.to_string(),
            language: "en".to_string(),
            entities: Vec::new(), // Let Presidio use all its recognizers
            score_threshold,
        };

        let url = format!("{}/analyze", self.base_url);

        for attempt in 0..=self.max_retries {
            if attempt > 0 {
                tracing::debug!(attempt, "Retrying Presidio /analyze request");
                self.retry_delay(attempt).await;
            }

            match self.http.post(&url).json(&request).send().await {
                Ok(resp) if resp.status().is_success() => {
                    match resp.json::<AnalyzeResponse>().await {
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

                            return Ok(Some(matches));
                        }
                        Err(e) => {
                            return Err(PresidioError::InvalidResponse(e.to_string()));
                        }
                    }
                }
                Ok(resp) => {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    let err = self.classify_status(status, &body);

                    if self.is_retryable(&err) && attempt < self.max_retries {
                        tracing::warn!(
                            attempt,
                            max_retries = self.max_retries,
                            "Presidio /analyze returned {}; will retry",
                            status
                        );
                        continue;
                    }
                    return Err(err);
                }
                Err(e) => {
                    let err = PresidioError::ServiceUnavailable {
                        status: None,
                        detail: e.to_string(),
                    };

                    if attempt < self.max_retries {
                        tracing::debug!(
                            attempt,
                            "Presidio service unreachable; will retry: {}", e
                        );
                        continue;
                    }
                    return Err(err);
                }
            }
        }

        // Unreachable, but satisfy the compiler.
        Err(PresidioError::ServiceUnavailable {
            status: None,
            detail: "Exhausted all retries".to_string(),
        })
    }

    /// Analyse text — convenience wrapper returning `Option` for callers
    /// that use graceful degradation (falls back to custom recognizers).
    ///
    /// Returns `None` if Presidio is disabled or the service is unreachable.
    /// For diagnostic detail, use [`analyze_with_error`] instead.
    pub async fn analyze(&self, text: &str, score_threshold: f64) -> Option<Vec<PiiMatch>> {
        match self.analyze_with_error(text, score_threshold).await {
            Ok(matches) => matches,
            Err(e) => {
                // This is expected if the Presidio service isn't running.
                // Log at debug level so it doesn't spam in normal operation.
                tracing::debug!(
                    "Presidio analysis failed (falling back to custom recognizers): {}", e
                );
                None
            }
        }
    }

    /// Health check — returns `Ok(true)` if the Presidio service is reachable
    /// and healthy, `Ok(false)` if it reports degraded, or `Err` if unreachable.
    ///
    /// Uses a dedicated (shorter) timeout so a slow health check never blocks
    /// the caller for the full request timeout window.
    pub async fn health_check_with_status(&self) -> Result<bool, PresidioError> {
        if !self.enabled {
            return Ok(false);
        }

        let url = format!("{}/health", self.base_url);
        let health_client = Client::builder()
            .timeout(Duration::from_secs(DEFAULT_HEALTH_CHECK_TIMEOUT_SECS))
            .connect_timeout(Duration::from_secs(DEFAULT_CONNECT_TIMEOUT_SECS))
            .build()
            .unwrap_or_else(|_| Client::new());

        for attempt in 0..=self.max_retries {
            if attempt > 0 {
                self.retry_delay(attempt).await;
            }

            match health_client.get(&url).send().await {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    return match status {
                        HTTP_OK => Ok(true),
                        HTTP_SERVICE_UNAVAILABLE => Ok(false),
                        _ => Err(PresidioError::ServiceUnavailable {
                            status: Some(status),
                            detail: resp.text().await.unwrap_or_default(),
                        }),
                    };
                }
                Err(e) => {
                    if attempt < self.max_retries {
                        tracing::debug!(attempt, "Health check failed; will retry: {}", e);
                        continue;
                    }
                    return Err(PresidioError::ServiceUnavailable {
                        status: None,
                        detail: e.to_string(),
                    });
                }
            }
        }

        Err(PresidioError::ServiceUnavailable {
            status: None,
            detail: "Exhausted all retries".to_string(),
        })
    }

    /// Legacy health check — returns `true` if the Presidio service is reachable.
    ///
    /// For richer diagnostics, prefer [`health_check_with_status`].
    pub async fn health_check(&self) -> bool {
        self.health_check_with_status().await.unwrap_or(false)
    }
}

/// Builder for [`PresidioClient`] with configurable retries and timeouts.
pub struct PresidioClientBuilder {
    base_url: String,
    enabled: bool,
    request_timeout: Duration,
    connect_timeout: Duration,
    health_check_timeout: Duration,
    max_retries: u32,
    retry_base_delay: Duration,
}

impl PresidioClientBuilder {
    pub fn request_timeout(mut self, d: Duration) -> Self {
        self.request_timeout = d;
        self
    }
    pub fn connect_timeout(mut self, d: Duration) -> Self {
        self.connect_timeout = d;
        self
    }
    pub fn health_check_timeout(mut self, d: Duration) -> Self {
        self.health_check_timeout = d;
        self
    }
    /// Set the maximum number of retry attempts for transient failures.
    /// `0` means a single attempt (no retries).
    pub fn max_retries(mut self, n: u32) -> Self {
        self.max_retries = n;
        self
    }
    /// Set the base delay for exponential back-off between retries.
    pub fn retry_base_delay(mut self, d: Duration) -> Self {
        self.retry_base_delay = d;
        self
    }

    pub fn build(self) -> PresidioClient {
        let base_url = self.base_url.trim_end_matches('/').to_string();
        let http = Client::builder()
            .timeout(self.request_timeout)
            .connect_timeout(self.connect_timeout)
            .build()
            .unwrap_or_else(|_| Client::new());

        PresidioClient {
            http,
            base_url,
            enabled: self.enabled,
            max_retries: self.max_retries,
            retry_base_delay: self.retry_base_delay,
        }
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
        assert_eq!(presidio_entity_to_pii_type("PERSON"), PiiType::Person);
        assert_eq!(presidio_entity_to_pii_type("LOCATION"), PiiType::Location);
        assert_eq!(presidio_entity_to_pii_type("ORGANIZATION"), PiiType::Organization);
        assert_eq!(presidio_entity_to_pii_type("UNKNOWN_TYPE"), PiiType::Custom("UNKNOWN_TYPE".to_string()));
    }

    #[test]
    fn test_client_disabled_returns_none() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let client = PresidioClient::new("http://localhost:9999".into(), false);
        let result = rt.block_on(client.analyze("test", 0.5));
        assert!(result.is_none());
    }

    #[test]
    fn test_error_display() {
        let err = PresidioError::ServiceUnavailable {
            status: Some(503),
            detail: "down".to_string(),
        };
        assert!(err.to_string().contains("503"));

        let err = PresidioError::Disabled;
        assert!(err.to_string().contains("disabled"));

        let err = PresidioError::BadRequest("missing text".to_string());
        assert!(err.to_string().contains("missing text"));
    }

    #[test]
    fn test_builder_custom_timeouts() {
        let client = PresidioClient::builder("http://localhost:3000".into(), true)
            .max_retries(5)
            .request_timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(3))
            .retry_base_delay(Duration::from_millis(200))
            .build();
        assert!(client.is_enabled());
        assert_eq!(client.max_retries, 5);
    }

    #[test]
    fn test_classify_status() {
        let client = PresidioClient::new("http://localhost:3000".into(), true);

        let err = client.classify_status(reqwest::StatusCode::BAD_REQUEST, "bad");
        assert!(matches!(err, PresidioError::BadRequest(_)));

        let err = client.classify_status(reqwest::StatusCode::SERVICE_UNAVAILABLE, "unavail");
        assert!(matches!(err, PresidioError::ServiceUnavailable { .. }));

        let err = client.classify_status(reqwest::StatusCode::INTERNAL_SERVER_ERROR, "boom");
        assert!(matches!(err, PresidioError::InternalError { .. }));
    }
}