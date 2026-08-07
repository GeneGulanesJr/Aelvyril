//! Liquid LFM2.5-Encoder-350M-Policy-Linter integration.
//!
//! Zero-shot rule matching: free-text rules + text → list of token-level violations.
//! Each violation carries the matched rule text, the per-rule action (warn/block),
//! and the token span/score.
//!
//! Calls the Python sidecar's `/liquid/policy` endpoint. The sidecar loads
//! `Lfm2BidirForRuleMatching` on first request and reuses it across calls.
//! Returns `None` on any failure (graceful degradation — the gateway forwards
//! the request normally and records the failure in the audit log).

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tracing;

const DEFAULT_REQUEST_TIMEOUT_SECS: u64 = 8;
const DEFAULT_CONNECT_TIMEOUT_SECS: u64 = 2;
const DEFAULT_MAX_RETRIES: u32 = 1;

/// Per-rule action: warn (audit + forward) or block (reject the request).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PolicyAction {
    Warn,
    Block,
}

impl PolicyAction {
    pub fn parse(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "block" => PolicyAction::Block,
            _ => PolicyAction::Warn,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            PolicyAction::Warn => "warn",
            PolicyAction::Block => "block",
        }
    }
}

/// A policy rule authored by the user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyRule {
    pub text: String,
    pub action: PolicyAction,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// Starter rule pack shipped with the app. All rules are `enabled: false` by
/// default: the linter enforces nothing until the user explicitly enables rules
/// (or clicks "Load starter pack" in Settings → Policy). Actions mix `warn`
/// (audit + forward) and `block` (short-circuit with 400).
pub fn default_policy_rules() -> Vec<PolicyRule> {
    // Credentials / secrets — Block
    // "api key", "bearer token", "client secret", "private key",
    // "BEGIN PRIVATE KEY", "connection string", "password"
    // Batch-PII extraction — Warn
    // "social security number", "credit card number", "bank account number",
    // "passport number", "national id", "customer data", "phone numbers"
    // Health information — Warn
    // "medical history", "diagnosis", "prescription", "medication", "mental health"
    vec![
        PolicyRule {
            text: "api key".into(),
            action: PolicyAction::Block,
            enabled: false,
        },
        PolicyRule {
            text: "bearer token".into(),
            action: PolicyAction::Block,
            enabled: false,
        },
        PolicyRule {
            text: "client secret".into(),
            action: PolicyAction::Block,
            enabled: false,
        },
        PolicyRule {
            text: "private key".into(),
            action: PolicyAction::Block,
            enabled: false,
        },
        PolicyRule {
            text: "BEGIN PRIVATE KEY".into(),
            action: PolicyAction::Block,
            enabled: false,
        },
        PolicyRule {
            text: "connection string".into(),
            action: PolicyAction::Block,
            enabled: false,
        },
        PolicyRule {
            text: "password".into(),
            action: PolicyAction::Block,
            enabled: false,
        },
        PolicyRule {
            text: "social security number".into(),
            action: PolicyAction::Warn,
            enabled: false,
        },
        PolicyRule {
            text: "credit card number".into(),
            action: PolicyAction::Warn,
            enabled: false,
        },
        PolicyRule {
            text: "bank account number".into(),
            action: PolicyAction::Warn,
            enabled: false,
        },
        PolicyRule {
            text: "passport number".into(),
            action: PolicyAction::Warn,
            enabled: false,
        },
        PolicyRule {
            text: "national id".into(),
            action: PolicyAction::Warn,
            enabled: false,
        },
        PolicyRule {
            text: "customer data".into(),
            action: PolicyAction::Warn,
            enabled: false,
        },
        PolicyRule {
            text: "phone numbers".into(),
            action: PolicyAction::Warn,
            enabled: false,
        },
        PolicyRule {
            text: "medical history".into(),
            action: PolicyAction::Warn,
            enabled: false,
        },
        PolicyRule {
            text: "diagnosis".into(),
            action: PolicyAction::Warn,
            enabled: false,
        },
        PolicyRule {
            text: "prescription".into(),
            action: PolicyAction::Warn,
            enabled: false,
        },
        PolicyRule {
            text: "medication".into(),
            action: PolicyAction::Warn,
            enabled: false,
        },
        PolicyRule {
            text: "mental health".into(),
            action: PolicyAction::Warn,
            enabled: false,
        },
    ]
}

/// A single token-level policy violation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyViolation {
    pub rule_index: usize,
    pub rule_text: String,
    pub action: PolicyAction,
    pub token_text: String,
    pub start: usize,
    pub end: usize,
    pub score: f64,
}

#[derive(Debug, Serialize)]
struct PolicyRequest<'a> {
    text: &'a str,
    rules: Vec<WireRule<'a>>,
}

#[derive(Debug, Serialize)]
struct WireRule<'a> {
    text: &'a str,
    action: &'a str,
}

#[derive(Debug, Deserialize)]
struct PolicyResponse {
    violations: Vec<WireViolation>,
}

#[derive(Debug, Deserialize)]
struct WireViolation {
    #[serde(default)]
    rule_index: usize,
    #[serde(default)]
    rule_text: String,
    action: String,
    token_text: String,
    start: usize,
    end: usize,
    score: f64,
}

/// Errors from the policy linter client.
#[derive(Debug, Clone)]
pub enum PolicyError {
    Disabled,
    ServiceUnavailable { status: Option<u16>, detail: String },
    InvalidResponse(String),
    BadRequest(String),
    InternalError { status: u16, detail: String },
}

impl std::fmt::Display for PolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disabled => write!(f, "Policy linter is disabled"),
            Self::ServiceUnavailable { status, detail } => write!(
                f,
                "Policy service unavailable (status={:?}): {}",
                status, detail
            ),
            Self::InvalidResponse(msg) => write!(f, "Policy returned invalid response: {}", msg),
            Self::BadRequest(msg) => write!(f, "Policy bad request: {}", msg),
            Self::InternalError { status, detail } => write!(
                f,
                "Policy internal error (status={}): {}",
                status, detail
            ),
        }
    }
}

impl std::error::Error for PolicyError {}

#[derive(Clone)]
pub struct LiquidPolicyClient {
    http: reqwest::Client,
    base_url: String,
    enabled: bool,
    max_retries: u32,
    retry_base_delay: Duration,
}

impl LiquidPolicyClient {
    pub fn new(base_url: String, enabled: bool) -> Self {
        Self::builder(base_url, enabled).build()
    }

    pub fn builder(base_url: String, enabled: bool) -> LiquidPolicyClientBuilder {
        LiquidPolicyClientBuilder {
            base_url,
            enabled,
            request_timeout: Duration::from_secs(DEFAULT_REQUEST_TIMEOUT_SECS),
            connect_timeout: Duration::from_secs(DEFAULT_CONNECT_TIMEOUT_SECS),
            max_retries: DEFAULT_MAX_RETRIES,
            retry_base_delay: Duration::from_millis(200),
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
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Lint `text` against `rules`. Returns `None` on any failure (graceful).
    pub async fn lint(
        &self,
        text: &str,
        rules: &[PolicyRule],
    ) -> Option<Vec<PolicyViolation>> {
        match self.lint_with_error(text, rules).await {
            Ok(v) => v,
            Err(e) => {
                tracing::debug!("Policy lint failed (forwarding normally): {}", e);
                None
            }
        }
    }

    pub async fn lint_with_error(
        &self,
        text: &str,
        rules: &[PolicyRule],
    ) -> Result<Option<Vec<PolicyViolation>>, PolicyError> {
        if !self.enabled {
            return Ok(None);
        }
        let active: Vec<&PolicyRule> = rules.iter().filter(|r| r.enabled).collect();
        if active.is_empty() {
            return Ok(Some(Vec::new()));
        }

        let wire_rules: Vec<WireRule<'_>> = active
            .iter()
            .map(|r| WireRule {
                text: r.text.as_str(),
                action: r.action.as_str(),
            })
            .collect();

        let request = PolicyRequest {
            text,
            rules: wire_rules,
        };
        let url = format!("{}/liquid/policy", self.base_url);

        for attempt in 0..=self.max_retries {
            if attempt > 0 {
                tokio::time::sleep(self.retry_base_delay).await;
            }
            match self.http.post(&url).json(&request).send().await {
                Ok(resp) if resp.status().is_success() => {
                    let body: PolicyResponse = resp
                        .json()
                        .await
                        .map_err(|e| PolicyError::InvalidResponse(e.to_string()))?;
                    let mut out = Vec::with_capacity(body.violations.len());
                    for v in body.violations {
                        out.push(PolicyViolation {
                            rule_index: v.rule_index,
                            rule_text: v.rule_text,
                            action: PolicyAction::parse(&v.action),
                            token_text: v.token_text,
                            start: v.start,
                            end: v.end,
                            score: v.score,
                        });
                    }
                    return Ok(Some(out));
                }
                Ok(resp) => {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    let code = status.as_u16();
                    let err = match code {
                        400 => PolicyError::BadRequest(body),
                        500..=599 => PolicyError::InternalError { status: code, detail: body },
                        _ => PolicyError::ServiceUnavailable {
                            status: Some(code),
                            detail: body,
                        },
                    };
                    if attempt >= self.max_retries {
                        return Err(err);
                    }
                }
                Err(e) => {
                    if attempt >= self.max_retries {
                        return Err(PolicyError::ServiceUnavailable {
                            status: None,
                            detail: e.to_string(),
                        });
                    }
                }
            }
        }
        Err(PolicyError::ServiceUnavailable {
            status: None,
            detail: "Exhausted all retries".to_string(),
        })
    }
}

pub struct LiquidPolicyClientBuilder {
    base_url: String,
    enabled: bool,
    request_timeout: Duration,
    connect_timeout: Duration,
    max_retries: u32,
    retry_base_delay: Duration,
}

impl LiquidPolicyClientBuilder {
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
    pub fn build(self) -> LiquidPolicyClient {
        let base_url = self.base_url.trim_end_matches('/').to_string();
        let http = reqwest::Client::builder()
            .timeout(self.request_timeout)
            .connect_timeout(self.connect_timeout)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        LiquidPolicyClient {
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
    fn test_policy_action_parse() {
        assert_eq!(PolicyAction::parse("warn"), PolicyAction::Warn);
        assert_eq!(PolicyAction::parse("BLOCK"), PolicyAction::Block);
        assert_eq!(PolicyAction::parse("other"), PolicyAction::Warn);
    }

    #[test]
    fn test_default_policy_rules() {
        let rules = default_policy_rules();
        assert!(
            rules.len() >= 15,
            "starter pack should have at least 15 rules, got {}",
            rules.len()
        );
        // All disabled by default.
        for r in &rules {
            assert!(!r.enabled, "rule {:?} should be disabled by default", r.text);
            // Action must be a valid PolicyAction variant.
            assert!(
                r.action == PolicyAction::Warn || r.action == PolicyAction::Block,
                "rule {:?} has invalid action",
                r.text
            );
        }
        // No duplicate texts (case-insensitive).
        let mut seen = std::collections::HashSet::new();
        for r in &rules {
            let key = r.text.to_ascii_lowercase();
            assert!(
                seen.insert(key),
                "duplicate rule text detected in starter pack"
            );
        }
    }

    #[test]
    fn test_disabled_returns_none() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let client = LiquidPolicyClient::new("http://127.0.0.1:9999".into(), false);
        let rules = vec![PolicyRule {
            text: "flag competitor names".into(),
            action: PolicyAction::Warn,
            enabled: true,
        }];
        let result = rt.block_on(client.lint("hello", &rules));
        assert!(result.is_none());
    }
}