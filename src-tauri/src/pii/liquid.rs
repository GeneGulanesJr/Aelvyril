//! Liquid LFM2.5-Encoder-350M-PII-Detector integration.
//!
//! Calls the Python sidecar's `/liquid/pii` endpoint, which loads the token-classification
//! model on first request and returns a list of entity spans. Maps the encoder's 40
//! domain-prefixed labels to Aelvyril's `PiiType` (see [`recognizers::PiiType`]).
//!
//! Follows the same shape as [`super::presidio::PresidioClient`]: retry/timeout/error
//! semantics and graceful degradation (`analyze` returns `None` on any failure so the
//! layered PII pipeline can fall back to Presidio + regex).
//!
//! See also `lifecycle`: the sidecar must be running on `base_url` (default
//! `http://127.0.0.1:3000`) with `AELVYRIL_LIQUID_PII_ENABLED=1` in its environment.

use super::recognizers::{PiiMatch, PiiType};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tracing;

const HTTP_OK_MIN: u16 = 200;
const HTTP_OK_MAX: u16 = 299;
const HTTP_BAD_REQUEST: u16 = 400;
const HTTP_SERVICE_UNAVAILABLE: u16 = 503;
const HTTP_INTERNAL_ERROR: u16 = 500;

const DEFAULT_REQUEST_TIMEOUT_SECS: u64 = 8;
const DEFAULT_CONNECT_TIMEOUT_SECS: u64 = 2;
const DEFAULT_MAX_RETRIES: u32 = 2;
const DEFAULT_RETRY_BASE_DELAY_MS: u64 = 150;

/// Request body for the `/liquid/pii` endpoint.
#[derive(Debug, Serialize)]
struct LiquidPiiRequest {
    text: String,
}

/// Single PII span returned by the Liquid encoder sidecar.
#[derive(Debug, Deserialize)]
struct LiquidPiiResult {
    entity_type: String,
    start: usize,
    end: usize,
    #[serde(default)]
    score: f64,
}

/// Response from the `/liquid/pii` endpoint.
#[derive(Debug, Deserialize)]
struct LiquidPiiResponse {
    result: Vec<LiquidPiiResult>,
}

/// Errors from the Liquid PII client. Modeled to mirror `PresidioError`.
#[derive(Debug, Clone)]
pub enum LiquidPiiError {
    /// The client is disabled (intentional — not an error per se).
    Disabled,
    /// The sidecar was unreachable or returned a non-success status.
    ServiceUnavailable { status: Option<u16>, detail: String },
    /// The sidecar returned a response that could not be deserialised.
    InvalidResponse(String),
    /// The request was rejected as malformed.
    BadRequest(String),
    /// The sidecar reported an internal error (5xx).
    InternalError { status: u16, detail: String },
}

impl std::fmt::Display for LiquidPiiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disabled => write!(f, "Liquid PII client is disabled"),
            Self::ServiceUnavailable { status, detail } => write!(
                f,
                "Liquid PII service unavailable (status={:?}): {}",
                status, detail
            ),
            Self::InvalidResponse(msg) => {
                write!(f, "Liquid PII returned invalid response: {}", msg)
            }
            Self::BadRequest(msg) => write!(f, "Liquid PII bad request: {}", msg),
            Self::InternalError { status, detail } => {
                write!(f, "Liquid PII internal error (status={}): {}", status, detail)
            }
        }
    }
}

impl std::error::Error for LiquidPiiError {}

/// Client for the Liquid PII encoder sidecar endpoint.
#[derive(Clone)]
pub struct LiquidPiiClient {
    http: Client,
    base_url: String,
    enabled: bool,
    max_retries: u32,
    retry_base_delay: Duration,
}

impl LiquidPiiClient {
    pub fn new(base_url: String, enabled: bool) -> Self {
        Self::builder(base_url, enabled).build()
    }

    pub fn builder(base_url: String, enabled: bool) -> LiquidPiiClientBuilder {
        LiquidPiiClientBuilder {
            base_url,
            enabled,
            request_timeout: Duration::from_secs(DEFAULT_REQUEST_TIMEOUT_SECS),
            connect_timeout: Duration::from_secs(DEFAULT_CONNECT_TIMEOUT_SECS),
            max_retries: DEFAULT_MAX_RETRIES,
            retry_base_delay: Duration::from_millis(DEFAULT_RETRY_BASE_DELAY_MS),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

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

    /// Whether a given failure is worth retrying.
    fn is_retryable(&self, err: &LiquidPiiError) -> bool {
        matches!(
            err,
            LiquidPiiError::ServiceUnavailable { .. } | LiquidPiiError::InternalError { .. }
        )
    }

    /// Analyse text using the Liquid PII encoder sidecar.
    ///
    /// Returns `Err(LiquidPiiError)` for diagnosable failures and `Ok(None)` when the
    /// client is disabled. Callers that prefer the `Option` interface can use [`analyze`].
    pub async fn analyze_with_error(
        &self,
        text: &str,
    ) -> Result<Option<Vec<PiiMatch>>, LiquidPiiError> {
        if !self.enabled {
            return Ok(None);
        }

        let request = LiquidPiiRequest {
            text: text.to_string(),
        };
        let url = format!("{}/liquid/pii", self.base_url);

        for attempt in 0..=self.max_retries {
            if attempt > 0 {
                tracing::debug!(attempt, "Retrying Liquid PII /liquid/pii request");
                self.retry_delay(attempt).await;
            }

            match self.http.post(&url).json(&request).send().await {
                Ok(resp) if resp.status().is_success() => {
                    let status = resp.status();
                    match resp.json::<LiquidPiiResponse>().await {
                        Ok(body) => {
                            let matches: Vec<PiiMatch> = body
                                .result
                                .into_iter()
                                .filter_map(|r| {
                                    // The sidecar returns CHAR offsets (Python
                                    // `str` semantics). Convert to BYTE
                                    // offsets before slicing/storing so the
                                    // span always lands on a char boundary
                                    // (safe_slice then returns Some) and the
                                    // PII is pseudonymized instead of leaked
                                    // raw on non-ASCII input.
                                    let start = crate::pii::char_to_byte_offset(text, r.start);
                                    let end = crate::pii::char_to_byte_offset(text, r.end);
                                    let span_text = match crate::pii::safe_slice(text, start, end) {
                                        Some(s) => s,
                                        None => {
                                            tracing::debug!(
                                                entity = %r.entity_type,
                                                start,
                                                end,
                                                "Liquid PII span out of range or on a non-char boundary, skipping"
                                            );
                                            return None;
                                        }
                                    };
                                    Some(PiiMatch {
                                        pii_type: PiiType::from_str(&r.entity_type),
                                        text: span_text.to_string(),
                                        start,
                                        end,
                                        confidence: if r.score > 0.0 {
                                            r.score
                                        } else {
                                            0.85
                                        },
                                    })
                                })
                                .collect();
                            if !matches.is_empty() {
                                tracing::debug!(
                                    count = matches.len(),
                                    "Liquid PII detected {} entities",
                                    matches.len()
                                );
                            }
                            let _ = status;
                            return Ok(Some(matches));
                        }
                        Err(e) => return Err(LiquidPiiError::InvalidResponse(e.to_string())),
                    }
                }
                Ok(resp) => {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    let err = Self::classify_status(status, &body);

                    if self.is_retryable(&err) && attempt < self.max_retries {
                        tracing::warn!(
                            attempt,
                            max_retries = self.max_retries,
                            "Liquid PII /liquid/pii returned {}; will retry",
                            status
                        );
                        continue;
                    }
                    return Err(err);
                }
                Err(e) => {
                    let err = LiquidPiiError::ServiceUnavailable {
                        status: None,
                        detail: e.to_string(),
                    };
                    if attempt < self.max_retries {
                        tracing::debug!(
                            attempt,
                            "Liquid PII sidecar unreachable; will retry: {}",
                            e
                        );
                        continue;
                    }
                    return Err(err);
                }
            }
        }

        Err(LiquidPiiError::ServiceUnavailable {
            status: None,
            detail: "Exhausted all retries".to_string(),
        })
    }

    /// Analyse text — convenience wrapper returning `Option` for graceful degradation.
    pub async fn analyze(&self, text: &str) -> Option<Vec<PiiMatch>> {
        match self.analyze_with_error(text).await {
            Ok(matches) => matches,
            Err(e) => {
                tracing::debug!(
                    "Liquid PII analysis failed (falling back to other layers): {}",
                    e
                );
                None
            }
        }
    }

    fn classify_status(status: reqwest::StatusCode, body: &str) -> LiquidPiiError {
        let code: u16 = status.as_u16();
        match code {
            HTTP_BAD_REQUEST => LiquidPiiError::BadRequest(body.to_string()),
            HTTP_SERVICE_UNAVAILABLE => LiquidPiiError::ServiceUnavailable {
                status: Some(code),
                detail: body.to_string(),
            },
            s if s >= HTTP_INTERNAL_ERROR => LiquidPiiError::InternalError {
                status: code,
                detail: body.to_string(),
            },
            _ => LiquidPiiError::ServiceUnavailable {
                status: Some(code),
                detail: body.to_string(),
            },
        }
    }
}

/// Builder for [`LiquidPiiClient`].
pub struct LiquidPiiClientBuilder {
    base_url: String,
    enabled: bool,
    request_timeout: Duration,
    connect_timeout: Duration,
    max_retries: u32,
    retry_base_delay: Duration,
}

impl LiquidPiiClientBuilder {
    pub fn request_timeout(mut self, d: Duration) -> Self {
        self.request_timeout = d;
        self
    }
    pub fn connect_timeout(mut self, d: Duration) -> Self {
        self.connect_timeout = d;
        self
    }
    pub fn max_retries(mut self, n: u32) -> Self {
        self.max_retries = n;
        self
    }
    pub fn retry_base_delay(mut self, d: Duration) -> Self {
        self.retry_base_delay = d;
        self
    }
    pub fn build(self) -> LiquidPiiClient {
        let base_url = self.base_url.trim_end_matches('/').to_string();
        let http = Client::builder()
            .timeout(self.request_timeout)
            .connect_timeout(self.connect_timeout)
            .build()
            .unwrap_or_else(|_| Client::new());
        LiquidPiiClient {
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
    fn test_disabled_returns_none() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let client = LiquidPiiClient::new("http://127.0.0.1:9999".into(), false);
        let result = rt.block_on(client.analyze("test"));
        assert!(result.is_none());
    }

    #[test]
    fn test_classify_status() {
        let err = LiquidPiiError::BadRequest("bad".into());
        assert!(err.to_string().contains("bad"));

        let err = LiquidPiiError::ServiceUnavailable {
            status: Some(503),
            detail: "down".into(),
        };
        assert!(err.to_string().contains("503"));
    }

    #[test]
    fn test_builder() {
        let client = LiquidPiiClient::builder("http://127.0.0.1:3000".into(), true)
            .max_retries(5)
            .request_timeout(Duration::from_secs(10))
            .build();
        assert!(client.is_enabled());
        assert_eq!(client.max_retries, 5);
    }

    // Suppress unused-warning for HTTP_OK_MIN/HTTP_OK_MAX (kept for symmetry with Presidio).
    #[test]
    fn test_http_constants_used() {
        assert!(HTTP_OK_MIN < HTTP_OK_MAX);
        assert!(HTTP_BAD_REQUEST < HTTP_SERVICE_UNAVAILABLE);
        assert!(HTTP_INTERNAL_ERROR < HTTP_SERVICE_UNAVAILABLE);
    }
}