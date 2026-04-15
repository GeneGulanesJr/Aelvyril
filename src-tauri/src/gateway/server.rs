//! Gateway HTTP server — route definitions and request handlers.
//!
//! The heavy lifting has been extracted into focused submodules:
//! - [`auth`] — client identity, authentication, rate limiting
//! - [`session_id`] — session ID derivation from headers
//! - [`pii_handler`] — PII detection, pseudonymization, rehydration
//! - [`forward`] — upstream forwarding, streaming, failover
//! - [`body`] (inside `pii_handler`) — JSON body text extraction/replacement

use axum::{
    extract::{Json, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Router,
};

use std::sync::Arc;
use tauri::Manager;
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::gateway::router;
use crate::perf::benchmark::LatencyBuilder;
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
                .timeout(std::time::Duration::from_secs(120))
                .build()?,
            pii_engine: s.pii_engine.clone(),
        }
    };

    let port = {
        let s = state.read().await;
        s.gateway_port
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

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!("🛡️  Aelvyril gateway listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

// ── Chat Completions Handler ────────────────────────────────────────────────

/// Handle POST /v1/chat/completions — the main gateway endpoint.
///
/// Pipeline: authenticate → resolve provider → detect PII → pseudonymize
///           → forward → rehydrate → respond (with optional failover).
async fn handle_chat_completions(
    State(gw): State<GatewayState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
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
        let fwd_ctx = ForwardContext {
            gw: &gw,
            session_id: &session_id,
            upstream_url: &upstream_url,
            api_key: &ctx.api_key,
            sanitized_body: &sanitized_body,
            is_anthropic,
            provider_name: &ctx.provider.name,
            model: &ctx.model,
        };

        match forward::forward_and_rehydrate(fwd_ctx, latency, false).await {
            Ok(response) => response,
            Err((latency, e)) => {
                forward::try_failover(FailoverContext {
                    gw: &gw,
                    latency,
                    session_id: &session_id,
                    body: &body,
                    text_content: &text_content,
                    matches: &matches,
                    primary_error: &e,
                    primary_provider: &ctx.provider,
                    model: &ctx.model,
                })
                .await
            }
        }
    }
}

// ── Passthrough Handler ─────────────────────────────────────────────────────

/// Handle passthrough requests to other /v1/* endpoints.
async fn handle_passthrough(
    State(gw): State<GatewayState>,
    headers: HeaderMap,
    axum::extract::Path(path): axum::extract::Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let app_state = gw.app_state.read().await;

    // Authenticate
    if let Err(resp) =
        super::auth::authenticate_passthrough(app_state.gateway_key.as_ref(), &headers)
    {
        return resp;
    }

    // Default to first provider for passthrough
    let provider = match app_state.providers.first() {
        Some(p) => p.clone(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "No providers configured" })),
            )
                .into_response();
        }
    };

    let api_key = match router::get_provider_api_key(&provider.name) {
        Ok(k) => k,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": format!("Cannot retrieve API key: {}", e)
                })),
            )
                .into_response();
        }
    };

    drop(app_state);

    // Scan for PII in passthrough requests
    let text_content = body::extract_text_from_body(&body);
    let sanitized_body = if text_content.is_empty() {
        body
    } else {
        let pii_engine = gw.pii_engine.read().await;
        let matches = pii_engine.detect(&text_content).await;
        drop(pii_engine);

        if matches.is_empty() {
            body
        } else {
            let mut pseudonymizer = crate::pseudonym::Pseudonymizer::new();
            let (sanitized_text, _) = pseudonymizer.pseudonymize(&text_content, &matches);
            let mut s_body = body;
            body::replace_text_in_body(&mut s_body, &text_content, &sanitized_text);
            tracing::warn!(
                "PII detected in passthrough /v1/{}: {} entities found, pseudonymizing",
                path,
                matches.len()
            );
            s_body
        }
    };

    let url = router::build_passthrough_url(&provider, &path);
    let is_anthropic = provider.name.to_lowercase().contains("anthropic");

    match crate::gateway::streaming::forward_request(
        &gw.http_client,
        &url,
        &api_key,
        &sanitized_body,
        is_anthropic,
    )
    .await
    {
        Ok(response) => Json(response).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}
