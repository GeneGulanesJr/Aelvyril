//! Authentication and client identity derivation for the gateway.

use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json};
use sha2::{Digest, Sha256};

/// Number of hex characters to use from the SHA-256 hash for client IDs
const CLIENT_ID_HEX_LENGTH: usize = 16;

use crate::gateway::router;
use crate::security::rate_limit::{ConcurrentGuard, RateLimitResult};
use crate::AppState;

// ── Types ────────────────────────────────────────────────────────────────────

/// Resolved context after authentication and provider lookup.
pub struct AuthenticatedRequest {
    pub model: String,
    pub provider: crate::config::ProviderConfig,
    pub api_key: String,
}

// ── Client Identity ─────────────────────────────────────────────────────────

/// Derive a client identity from the Authorization header for rate limiting.
/// Uses SHA-256 of the bearer token so we never store the raw key.
pub fn derive_client_id(headers: &HeaderMap) -> String {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("anonymous");
    let mut hasher = Sha256::new();
    hasher.update(auth.as_bytes());
    let hash = hasher.finalize();
    hex::encode(hash)[..CLIENT_ID_HEX_LENGTH].to_string()
}

// ── Request Authentication ──────────────────────────────────────────────────

/// Authenticate a request by checking the Authorization header.
pub fn authenticate_request(headers: &HeaderMap, gateway_key: &str) -> bool {
    let Some(auth) = headers.get("authorization") else {
        return false;
    };
    let Ok(auth_str) = auth.to_str() else {
        return false;
    };
    // Only accept the standard "Bearer <token>" format.
    // Rejecting raw key comparison prevents header injection in proxy setups.
    auth_str.strip_prefix("Bearer ") == Some(gateway_key)
}

/// Authenticate the request, resolve the upstream provider, and retrieve its API key.
/// Returns `Ok(AuthenticatedRequest)` on success or an error response on failure.
pub async fn authenticate_and_resolve(
    app_state: &tokio::sync::RwLockReadGuard<'_, AppState>,
    headers: &HeaderMap,
    body: &serde_json::Value,
) -> Result<AuthenticatedRequest, axum::response::Response> {
    // 1. Verify gateway key is configured
    let gateway_key = match &app_state.gateway_key {
        Some(k) => k.clone(),
        None => {
            return Err((
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({
                    "error": "Gateway key not configured. Generate one in the Aelvyril app."
                })),
            )
                .into_response());
        }
    };

    // 2. Validate the request's API key
    if !authenticate_request(headers, &gateway_key) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Invalid gateway API key" })),
        )
            .into_response());
    }

    // 3. Extract model name
    let model = body
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("unknown")
        .to_string();

    // 4. Resolve upstream provider
    let provider = match router::resolve_provider(&app_state.providers, &model) {
        Ok(p) => p.clone(),
        Err(e) => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": e.to_string() })),
            )
                .into_response());
        }
    };

    // 5. Retrieve API key from keychain
    let api_key = match router::get_provider_api_key(&provider.name) {
        Ok(k) => k,
        Err(e) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": format!("Cannot retrieve API key for {}: {}", provider.name, e)
                })),
            )
                .into_response());
        }
    };

    Ok(AuthenticatedRequest {
        model,
        provider,
        api_key,
    })
}

// ── Rate Limiting ───────────────────────────────────────────────────────────

/// Build an axum response for rate limit denial.
fn rate_limit_response(reason: &str) -> axum::response::Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        Json(serde_json::json!({ "error": format!("Rate limit exceeded: {}", reason) })),
    )
        .into_response()
}

/// Rate-limiting middleware applied to all /v1/* routes.
pub async fn rate_limit_middleware(
    gw: axum::extract::State<crate::gateway::GatewayState>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let client_id = derive_client_id(&headers);
    let state = gw.app_state.read().await;
    let result = state.rate_limiter.check(&client_id);
    drop(state);

    match result {
        RateLimitResult::Allowed => {
            // check() already atomically reserved a concurrent slot;
            // ConcurrentGuard will release it when the request completes.
            let _guard =
                ConcurrentGuard {
                    active_requests: gw.app_state.read().await.rate_limiter.active_requests(),
                };
            next.run(request).await
        }
        RateLimitResult::DeniedMinuteLimit => rate_limit_response("too many requests per minute"),
        RateLimitResult::DeniedHourLimit => rate_limit_response("too many requests per hour"),
        RateLimitResult::DeniedConcurrentLimit => {
            rate_limit_response("too many concurrent requests")
        }
    }
}

/// Authenticate a passthrough request. Returns the gateway key, or an error response.
#[allow(clippy::result_large_err)]
pub fn authenticate_passthrough<'a>(
    gateway_key: Option<&'a String>,
    headers: &HeaderMap,
) -> Result<&'a str, axum::response::Response> {
    match gateway_key {
        Some(k) => {
            if authenticate_request(headers, k) {
                Ok(k)
            } else {
                Err((
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({ "error": "Invalid gateway API key" })),
                )
                    .into_response())
            }
        }
        None => Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Gateway key not configured" })),
        )
            .into_response()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_derive_client_id_same_key_same_id() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer test-key-123".parse().unwrap());
        let id1 = derive_client_id(&headers);
        let id2 = derive_client_id(&headers);
        assert_eq!(id1, id2);
    }

    #[test]
    fn test_derive_client_id_different_keys_different_ids() {
        let mut h1 = HeaderMap::new();
        h1.insert("authorization", "Bearer key-one".parse().unwrap());
        let mut h2 = HeaderMap::new();
        h2.insert("authorization", "Bearer key-two".parse().unwrap());
        assert_ne!(derive_client_id(&h1), derive_client_id(&h2));
    }

    #[test]
    fn test_authenticate_request_valid_bearer() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer my-secret-key".parse().unwrap());
        assert!(authenticate_request(&headers, "my-secret-key"));
    }

    #[test]
    fn test_authenticate_request_rejects_raw_key() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", "my-secret-key".parse().unwrap());
        assert!(!authenticate_request(&headers, "my-secret-key"));
    }

    #[test]
    fn test_authenticate_request_missing_header() {
        let headers = HeaderMap::new();
        assert!(!authenticate_request(&headers, "my-secret-key"));
    }
}
