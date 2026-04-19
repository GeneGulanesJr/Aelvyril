//! Gateway HTTP server — route definitions and request handlers.
//!
//! The heavy lifting has been extracted into focused submodules:
//! - [`auth`] — client identity, authentication, rate limiting
//! - [`session_id`] — session ID derivation from headers
//! - [`pii_handler`] — PII detection, pseudonymization, rehydration
//! - [`forward`] — upstream forwarding, streaming, failover
//! - [`body`] (inside `pii_handler`) — JSON body text extraction/replacement
//! - `token_usage` — per-call token tracking, cost estimation, and stats

use axum::{
    extract::{Json, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Router,
};

use std::sync::Arc;
use tauri::Manager;

/// Default timeout (seconds) for upstream HTTP requests
const GATEWAY_HTTP_TIMEOUT_SECS: u64 = 120;
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::gateway::router;
use crate::perf::benchmark::LatencyBuilder;
use crate::token_usage::pricing;
use crate::token_usage::{TokenCountSource, TokenUsageEvent, TOKEN_USAGE_SCHEMA_VERSION};
use crate::AppState;

use super::forward::{self, FailoverContext, ForwardContext};
use super::pii_handler::body;
use super::session_id::derive_session_id;

// ── Gateway State ───────────────────────────────────────────────────────────

/// Shared gateway state (injected into handlers via axum State)
#[derive(Clone)]
pub struct GatewayState {
    pub app_state: Arc<RwLock<AppState>>,
    pub http_client: reqwest::Client,
    pub pii_engine: Arc<RwLock<crate::pii::PiiEngine>>,
}

// ── Server Setup ────────────────────────────────────────────────────────────

/// Start the gateway HTTP server.
pub async fn start_server(
    app_handle: tauri::AppHandle,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let state = app_handle.state::<Arc<RwLock<AppState>>>().inner().clone();

    let gateway_state = {
        let s = state.read().await;
        GatewayState {
            app_state: state.clone(),
            http_client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(GATEWAY_HTTP_TIMEOUT_SECS))
                .build()?,
            pii_engine: s.pii_engine.clone(),
        }
    };

    let (host, port) = {
        let s = state.read().await;
        (s.gateway_bind_address.clone(), s.gateway_port)
    };

    let api_routes = Router::new()
        .route("/v1/chat/completions", post(handle_chat_completions))
        .route("/v1/{*path}", any(handle_passthrough))
        .layer(axum::middleware::from_fn_with_state(
            gateway_state.clone(),
            super::auth::rate_limit_middleware,
        ));

    let ws_routes = crate::bridge::ws_router();

    let app = Router::new()
        .merge(api_routes)
        .merge(ws_routes)
        .route(
            "/health",
            get(|| async { Json(serde_json::json!({"status": "ok"})) }),
        )
        .layer(
            CorsLayer::new()
                .allow_origin(tower_http::cors::Any)
                .allow_methods([
                    axum::http::Method::GET,
                    axum::http::Method::POST,
                    axum::http::Method::OPTIONS,
                ])
                .allow_headers(tower_http::cors::Any),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(gateway_state);

    let host_ip: std::net::IpAddr = host
        .parse()
        .unwrap_or(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
    let addr = std::net::SocketAddr::from((host_ip, port));
    tracing::info!("🛡️  Aelvyril gateway listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

// ── Token Usage Recording ────────────────────────────────────────────────────

/// Record a token usage event from an API response. Fire-and-forget.
///
/// Extracts token counts from OpenAI or Anthropic response format and
/// records the event asynchronously. Never blocks the response path.
#[allow(clippy::too_many_arguments)]
fn record_token_usage_from_response(
    app_state: &Arc<RwLock<AppState>>,
    session_id: &str,
    model: &str,
    is_streaming: bool,
    is_anthropic: bool,
    response: &serde_json::Value,
    tool_name: &str,
    duration_ms: u64,
) {
    let (tokens_in_system, tokens_in_user, tokens_in_cached, tokens_out, token_count_source) =
        if is_anthropic {
            extract_anthropic_tokens(response)
        } else {
            extract_openai_tokens(response)
        };

    let event = TokenUsageEvent {
        schema_version: TOKEN_USAGE_SCHEMA_VERSION,
        event_id: uuid::Uuid::new_v4().to_string(),
        timestamp: chrono::Utc::now(),
        session_id: session_id.to_string(),
        tenant_id: crate::token_usage::DEFAULT_TENANT_ID.to_string(),
        tool_name: tool_name.to_string(),
        model_id: model.to_string(),
        retry_attempt: 0,
        tokens_in_system,
        tokens_in_user,
        tokens_in_cached,
        tokens_out,
        tokens_truncated: 0, // Populated if truncation is detected
        token_count_source,
        was_streamed: is_streaming,
        was_partial: false, // Updated for streaming if needed
        duration_ms,
        cost_estimate_cents: 0,   // Computed below
        pricing_as_of: String::new(), // Computed below
        cost_unavailable: false,  // Computed below
        success: true,
    };

    // Compute cost
    let (cost_cents, pricing_as_of, cost_unavailable) = pricing::estimate_cost_cents(
        &event.model_id,
        event.tokens_in_system,
        event.tokens_in_user,
        event.tokens_in_cached,
        event.tokens_out,
    );

    let event = TokenUsageEvent {
        cost_estimate_cents: cost_cents,
        pricing_as_of,
        cost_unavailable,
        ..event
    };

    // Fire-and-forget: record event asynchronously (never blocks response)
    let tracker = app_state.blocking_read().token_usage_tracker.clone();
    tracker.record(event);
}

/// Extract token counts from an OpenAI-style response.
fn extract_openai_tokens(response: &serde_json::Value) -> (u64, u64, u64, u64, TokenCountSource) {
    let usage = pricing::extract_openai_usage(response);

    if usage.prompt_tokens == 0 && usage.completion_tokens == 0 {
        // No usage data available
        let system_estimate = pricing::estimate_system_tokens(
            response
                .get("model")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown"),
        );
        (system_estimate, 0, 0, 0, TokenCountSource::Unavailable)
    } else {
        let tokens_in_system = pricing::estimate_system_tokens(
            response
                .get("model")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown"),
        );
        let tokens_in_user = if usage.prompt_tokens > tokens_in_system {
            usage.prompt_tokens - tokens_in_system
        } else {
            usage.prompt_tokens
        };
        let tokens_in_cached = usage.cached_tokens;
        (
            tokens_in_system,
            tokens_in_user,
            tokens_in_cached,
            usage.completion_tokens,
            TokenCountSource::ApiReported,
        )
    }
}

/// Extract token counts from an Anthropic-style response.
fn extract_anthropic_tokens(response: &serde_json::Value) -> (u64, u64, u64, u64, TokenCountSource) {
    let usage = pricing::extract_anthropic_usage(response);

    if usage.input_tokens == 0 && usage.output_tokens == 0 {
        let model = response
            .get("model")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown");
        let system_estimate = pricing::estimate_system_tokens(model);
        (system_estimate, 0, 0, 0, TokenCountSource::Unavailable)
    } else {
        // Anthropic reports cache_read_input_tokens as cached tokens
        let tokens_in_cached = usage.cache_read_input_tokens;
        let tokens_in_system = pricing::estimate_system_tokens(
            response
                .get("model")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown"),
        );
        // Subtract system tokens + cached from total input
        let tokens_in_user = if usage.input_tokens > tokens_in_system {
            usage.input_tokens - tokens_in_system
        } else {
            usage.input_tokens
        };
        (
            tokens_in_system,
            tokens_in_user,
            tokens_in_cached,
            usage.output_tokens,
            TokenCountSource::ApiReported,
        )
    }
}

// ── Chat Completions Handler ────────────────────────────────────────────────

/// Handle POST /v1/chat/completions — the main gateway endpoint.
///
/// Pipeline: authenticate → resolve provider → detect PII → pseudonymize
///           → forward → rehydrate → record token usage → respond
async fn handle_chat_completions(
    State(gw): State<GatewayState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let request_start = std::time::Instant::now();

    // 1. Authenticate + resolve provider
    let app_state_guard = gw.app_state.read().await;
    let ctx = match super::auth::authenticate_and_resolve(&app_state_guard, &headers, &body).await {
        Ok(ctx) => ctx,
        Err(resp) => return resp,
    };

    let mut latency = LatencyBuilder::new();
    latency.auth_done();

    // 2. Extract text and detect PII
    let text_content = body::extract_text_from_body(&body);
    let matches = super::pii_handler::detect_pii(&gw, &mut latency, &text_content).await;

    // 3. Pseudonymize + store mappings
    let session_id = derive_session_id(&headers);
    let is_streaming = body
        .get("stream")
        .and_then(|s| s.as_bool())
        .unwrap_or(false);
    let sanitized_body = super::pii_handler::pseudonymize_and_store(
        &app_state_guard,
        &mut latency,
        &session_id,
        &body,
        &text_content,
        &matches,
    );

    // 4. Record the request in the session
    app_state_guard.session_manager.record_request(
        &session_id,
        &ctx.provider.name,
        &ctx.model,
        &matches,
        is_streaming,
    );
    drop(app_state_guard);

    // 5. Forward to upstream
    let is_anthropic = ctx.provider.name.to_lowercase().contains("anthropic");
    let upstream_url = router::build_upstream_url(&ctx.provider);
    latency.upstream_start();

    if is_streaming {
        forward::handle_streaming(
            gw,
            latency,
            session_id,
            upstream_url,
            ctx.api_key,
            sanitized_body,
            is_anthropic,
            &ctx.provider.name,
            &ctx.model,
        )
        .await
    } else {
        forward_non_streaming(
            &gw,
            latency,
            &session_id,
            &upstream_url,
            &ctx.api_key,
            &sanitized_body,
            is_anthropic,
            &ctx.provider.name,
            &ctx.model,
            &body,
            &text_content,
            &matches,
            &ctx.provider,
            request_start,
        )
        .await
    }
}

/// Non-streaming forward: send request, rehydrate, or failover on error.
#[allow(clippy::too_many_arguments)]
async fn forward_non_streaming(
    gw: &GatewayState,
    latency: LatencyBuilder,
    session_id: &str,
    upstream_url: &str,
    api_key: &str,
    sanitized_body: &serde_json::Value,
    is_anthropic: bool,
    provider_name: &str,
    model: &str,
    body: &serde_json::Value,
    text_content: &str,
    matches: &[crate::pii::recognizers::PiiMatch],
    primary_provider: &crate::config::ProviderConfig,
    request_start: std::time::Instant,
) -> Response {
    let fwd_ctx = ForwardContext {
        gw,
        session_id,
        upstream_url,
        api_key,
        sanitized_body,
        is_anthropic,
        provider_name,
        model,
    };

    match forward::forward_and_rehydrate(fwd_ctx, latency, false).await {
        Ok(response) => response,
        Err((latency, e)) => {
            record_failed_request(gw, session_id, model, request_start, &e);
            forward::try_failover(FailoverContext {
                gw,
                latency,
                session_id,
                body,
                text_content,
                matches,
                primary_error: &e,
                primary_provider,
                model,
            })
            .await
        }
    }
}

/// Record a failed (non-2xx) request to the token usage tracker.
fn record_failed_request(
    gw: &GatewayState,
    session_id: &str,
    model: &str,
    request_start: std::time::Instant,
    error: &str,
) {
    let tracker = gw.app_state.blocking_read().token_usage_tracker.clone();
    let event = crate::token_usage::tracker::TokenUsageTracker::new_err(
        session_id,
        model,
        "chat_completions",
        request_start.elapsed().as_millis() as u64,
        error,
    );
    tracker.record(event);
}

// ── Passthrough Handler ─────────────────────────────────────────────────────

/// Handle passthrough requests to other /v1/* endpoints.
async fn handle_passthrough(
    State(gw): State<GatewayState>,
    headers: HeaderMap,
    axum::extract::Path(path): axum::extract::Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let request_start = std::time::Instant::now();

    let (provider, api_key) = match resolve_passthrough_provider(&gw, &headers).await {
        Ok(resolved) => resolved,
        Err(resp) => return resp,
    };

    let sanitized_body = sanitize_passthrough_body(&gw, &body, &path).await;

    let url = router::build_passthrough_url(&provider, &path);
    let is_anthropic = provider.name.to_lowercase().contains("anthropic");
    let model = sanitized_body
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("unknown");

    match crate::gateway::streaming::forward_request(
        &gw.http_client,
        &url,
        &api_key,
        &sanitized_body,
        is_anthropic,
    )
    .await
    {
        Ok(response) => {
            let duration_ms = request_start.elapsed().as_millis() as u64;
            record_token_usage_from_response(
                &gw.app_state,
                "passthrough",
                model,
                false,
                is_anthropic,
                &response,
                "passthrough",
                duration_ms,
            );
            Json(response).into_response()
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

/// Authenticate and resolve the default provider + API key for passthrough requests.
async fn resolve_passthrough_provider(
    gw: &GatewayState,
    headers: &HeaderMap,
) -> Result<(crate::config::ProviderConfig, String), Response> {
    let app_state = gw.app_state.read().await;

    super::auth::authenticate_passthrough(app_state.gateway_key.as_ref(), headers)?;

    let provider = match app_state.providers.first() {
        Some(p) => p.clone(),
        None => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "No providers configured" })),
            )
                .into_response());
        }
    };

    let api_key = match router::get_provider_api_key(&provider.name) {
        Ok(k) => k,
        Err(e) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": format!("Cannot retrieve API key: {}", e)
                })),
            )
                .into_response());
        }
    };

    drop(app_state);
    Ok((provider, api_key))
}

/// Scan the request body for PII and pseudonymize if found.
async fn sanitize_passthrough_body(
    gw: &GatewayState,
    body: &serde_json::Value,
    path: &str,
) -> serde_json::Value {
    let text_content = body::extract_text_from_body(body);
    if text_content.is_empty() {
        return body.clone();
    }

    let pii_engine = gw.pii_engine.read().await;
    let matches = pii_engine.detect(&text_content).await;
    drop(pii_engine);

    if matches.is_empty() {
        return body.clone();
    }

    let mut pseudonymizer = crate::pseudonym::Pseudonymizer::new();
    let (sanitized_text, _) = pseudonymizer.pseudonymize(&text_content, &matches);
    let mut s_body = body.clone();
    body::replace_text_in_body(&mut s_body, &text_content, &sanitized_text);
    tracing::warn!(
        "PII detected in passthrough /v1/{}: {} entities found, pseudonymizing",
        path,
        matches.len()
    );
    s_body
}