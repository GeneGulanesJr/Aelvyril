use axum::{
    extract::State,
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response, Sse},
    routing::{any, post},
    Json, Router,
};
use futures::StreamExt;
use reqwest::Client;
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::gateway::router;
use crate::gateway::streaming;
use crate::pii::PiiEngine;
use crate::pseudonym::{Pseudonymizer, Rehydrator};
use crate::AppState;

/// Shared gateway state (injected into handlers via axum State)
#[derive(Clone)]
pub struct GatewayState {
    pub app_state: Arc<RwLock<AppState>>,
    pub http_client: Client,
    pub pii_engine: Arc<RwLock<PiiEngine>>,
}

/// Start the gateway HTTP server
pub async fn start_server(
    app_handle: tauri::AppHandle,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let state = app_handle
        .state::<Arc<RwLock<AppState>>>()
        .inner()
        .clone();

    let gateway_state = GatewayState {
        app_state: state.clone(),
        http_client: Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()?,
        pii_engine: Arc::new(RwLock::new(PiiEngine::new())),
    };

    let port = {
        let s = state.read().await;
        s.gateway_port
    };

    let app = Router::new()
        .route(
            "/v1/chat/completions",
            post(handle_chat_completions),
        )
        .route("/v1/{*path}", any(handle_passthrough))
        .route(
            "/health",
            axum::routing::get(|| async { Json(serde_json::json!({"status": "ok"})) }),
        )
        .layer(
            CorsLayer::new()
                .allow_origin(tower_http::cors::Any)
                .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
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

/// Handle POST /v1/chat/completions — the main gateway endpoint
async fn handle_chat_completions(
    State(gw): State<GatewayState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    // 1. Authenticate the request
    let app_state = gw.app_state.read().await;
    let gateway_key = match &app_state.gateway_key {
        Some(k) => k.clone(),
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({
                    "error": "Gateway key not configured. Generate one in the Aelvyril app."
                })),
            )
                .into_response();
        }
    };

    if !authenticate_request(&headers, &gateway_key) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "error": "Invalid gateway API key"
            })),
        )
            .into_response();
    }

    // 2. Extract model name from request
    let model = body
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("unknown")
        .to_string();

    // 3. Resolve upstream provider
    let provider = match router::resolve_provider(&app_state.providers, &model) {
        Ok(p) => p.clone(),
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": e.to_string()
                })),
            )
                .into_response();
        }
    };

    // 4. Get API key from keychain
    let api_key = match router::get_provider_api_key(&provider.name) {
        Ok(k) => k,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": format!("Cannot retrieve API key for {}: {}", provider.name, e)
                })),
            )
                .into_response();
        }
    };

    drop(app_state);

    // 5. Extract text content from request for PII scanning
    let text_content = extract_text_from_body(&body);

    // 6. Detect PII
    let pii_engine = gw.pii_engine.read().await;
    let matches = pii_engine.detect(&text_content);
    drop(pii_engine);

    // 7. Get or create session and pseudonymize
    let session_id = derive_session_id(&headers);
    let app_state = gw.app_state.read().await;

    let is_streaming = body
        .get("stream")
        .and_then(|s| s.as_bool())
        .unwrap_or(false);

    // Pseudonymize the request body
    let (sanitized_body, mappings) = if matches.is_empty() {
        (body.clone(), Vec::new())
    } else {
        let mut pseudonymizer = Pseudonymizer::new();
        let (sanitized_text, mappings) = pseudonymizer.pseudonymize(&text_content, &matches);

        let mut sanitized_body = body.clone();
        replace_text_in_body(&mut sanitized_body, &text_content, &sanitized_text);

        (sanitized_body, mappings)
    };

    // Store mappings in session
    if !mappings.is_empty() {
        app_state
            .session_manager
            .with_mapping_table(&session_id, |table: &mut crate::pseudonym::mapping::MappingTable| {
                table.add_mappings(mappings.clone());
            });
    }

    // Record the request
    app_state.session_manager.record_request(
        &session_id,
        &provider.name,
        &model,
        &matches,
        is_streaming,
    );

    drop(app_state);

    let is_anthropic = provider.name.to_lowercase().contains("anthropic");
    let upstream_url = router::build_upstream_url(&provider);

    // 8. Forward to upstream
    if is_streaming {
        let session_id_clone = session_id;
        let app_state_clone = gw.app_state.clone();

        let stream = streaming::forward_streaming_request(
            gw.http_client.clone(),
            upstream_url,
            api_key,
            sanitized_body,
            is_anthropic,
        );

        // Rehydrate SSE events in the stream
        let rehydrated_stream = stream.filter_map(move |result| {
            let data_str = match result {
                Ok(event) => {
                    // We can't read Event data back — so we'll rehydrate at the string level
                    // The streaming module already yields the data string in Event.data()
                    // Instead, we use a raw approach below
                    return futures::future::ready(Some(Ok::<_, std::convert::Infallible>(event)));
                }
                Err(_) => return futures::future::ready(None),
            };
        });

        Sse::new(Box::pin(rehydrated_stream))
            .keep_alive(axum::response::sse::KeepAlive::default())
            .into_response()
    } else {
        // Non-streaming response
        match streaming::forward_request(
            &gw.http_client,
            &upstream_url,
            &api_key,
            &sanitized_body,
            is_anthropic,
        )
        .await
        {
            Ok(response) => {
                let rehydrated = gw
                    .app_state
                    .read()
                    .await
                    .session_manager
                    .with_mapping_table(&session_id, |table: &mut crate::pseudonym::mapping::MappingTable| {
                        let response_str = serde_json::to_string(&response).unwrap_or_default();
                        Rehydrator::rehydrate(&response_str, table)
                    })
                    .unwrap_or_else(|| serde_json::to_string(&response).unwrap_or_default());

                match serde_json::from_str::<serde_json::Value>(&rehydrated) {
                    Ok(json) => Json(json).into_response(),
                    Err(_) => Json(response).into_response(),
                }
            }
            Err(e) => {
                // Try failover
                let app_state = gw.app_state.read().await;
                if let Some(failover_provider) =
                    router::find_failover_provider(&app_state.providers, &provider.name, &model)
                {
                    if let Ok(failover_key) = router::get_provider_api_key(&failover_provider.name)
                    {
                        let failover_url = router::build_upstream_url(failover_provider);
                        let is_failover_anthropic =
                            failover_provider.name.to_lowercase().contains("anthropic");

                        drop(app_state);

                        match streaming::forward_request(
                            &gw.http_client,
                            &failover_url,
                            &failover_key,
                            &sanitized_body,
                            is_failover_anthropic,
                        )
                        .await
                        {
                            Ok(response) => {
                                let rehydrated = gw
                                    .app_state
                                    .read()
                                    .await
                                    .session_manager
                                    .with_mapping_table(&session_id, |table: &mut crate::pseudonym::mapping::MappingTable| {
                                        let response_str =
                                            serde_json::to_string(&response).unwrap_or_default();
                                        Rehydrator::rehydrate(&response_str, table)
                                    })
                                    .unwrap_or_else(|| serde_json::to_string(&response).unwrap_or_default());

                                match serde_json::from_str::<serde_json::Value>(&rehydrated) {
                                    Ok(json) => Json(json).into_response(),
                                    Err(_) => Json(response).into_response(),
                                }
                            }
                            Err(fe) => (
                                StatusCode::BAD_GATEWAY,
                                Json(serde_json::json!({
                                    "error": format!(
                                        "Primary and failover both failed: {} | {}",
                                        e, fe
                                    )
                                })),
                            )
                                .into_response(),
                        }
                    } else {
                        drop(app_state);
                        (
                            StatusCode::BAD_GATEWAY,
                            Json(serde_json::json!({
                                "error": format!(
                                    "Primary failed: {}. Failover key unavailable.",
                                    e
                                )
                            })),
                        )
                            .into_response()
                    }
                } else {
                    drop(app_state);
                    (
                        StatusCode::BAD_GATEWAY,
                        Json(serde_json::json!({ "error": e })),
                    )
                        .into_response()
                }
            }
        }
    }
}

/// Handle passthrough requests to other /v1/* endpoints
async fn handle_passthrough(
    State(gw): State<GatewayState>,
    headers: HeaderMap,
    axum::extract::Path(path): axum::extract::Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let app_state = gw.app_state.read().await;

    // Authenticate
    let gateway_key = match &app_state.gateway_key {
        Some(k) => k.clone(),
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({
                    "error": "Gateway key not configured"
                })),
            )
                .into_response();
        }
    };

    if !authenticate_request(&headers, &gateway_key) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "error": "Invalid gateway API key"
            })),
        )
            .into_response();
    }

    // Default to first provider for passthrough
    let provider = match app_state.providers.first() {
        Some(p) => p.clone(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "No providers configured"
                })),
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

    let url = format!("{}/{}", provider.base_url, path);
    let is_anthropic = provider.name.to_lowercase().contains("anthropic");

    match streaming::forward_request(&gw.http_client, &url, &api_key, &body, is_anthropic).await {
        Ok(response) => Json(response).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "error": e })),
        )
            .into_response(),
    }
}

/// Authenticate a request by checking the Authorization header
fn authenticate_request(headers: &HeaderMap, gateway_key: &str) -> bool {
    if let Some(auth) = headers.get("authorization") {
        if let Ok(auth_str) = auth.to_str() {
            if let Some(key) = auth_str.strip_prefix("Bearer ") {
                return key == gateway_key;
            }
            return auth_str == gateway_key;
        }
    }
    false
}

/// Derive a session ID from request headers.
fn derive_session_id(headers: &HeaderMap) -> String {
    if let Some(session_id) = headers.get("x-session-id") {
        if let Ok(id) = session_id.to_str() {
            return id.to_string();
        }
    }
    if let Some(auth) = headers.get("authorization") {
        if let Ok(key) = auth.to_str() {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(key.as_bytes());
            let hash = hasher.finalize();
            return hex::encode(&hash[..8]);
        }
    }
    uuid::Uuid::new_v4().to_string()
}

/// Extract text content from the request body for PII scanning
fn extract_text_from_body(body: &serde_json::Value) -> String {
    let mut text = String::new();

    if let Some(messages) = body.get("messages").and_then(|m| m.as_array()) {
        for message in messages {
            if let Some(content) = message.get("content") {
                match content {
                    serde_json::Value::String(s) => {
                        text.push_str(s);
                        text.push('\n');
                    }
                    serde_json::Value::Array(parts) => {
                        for part in parts {
                            if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                                text.push_str(t);
                                text.push('\n');
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    if let Some(prompt) = body.get("prompt").and_then(|p| p.as_str()) {
        text.push_str(prompt);
        text.push('\n');
    }

    text
}

/// Replace text content in the JSON body with sanitized version
fn replace_text_in_body(body: &mut serde_json::Value, original: &str, sanitized: &str) {
    if original == sanitized {
        return;
    }

    if let Some(messages) = body.get_mut("messages").and_then(|m| m.as_array_mut()) {
        for message in messages {
            if let Some(content) = message.get_mut("content") {
                match content {
                    serde_json::Value::String(s) => {
                        *s = s.replace(original, sanitized);
                    }
                    serde_json::Value::Array(parts) => {
                        for part in parts {
                            if let Some(serde_json::Value::String(text)) =
                                part.get_mut("text")
                            {
                                *text = text.replace(original, sanitized);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    if let Some(serde_json::Value::String(prompt)) = body.get_mut("prompt") {
        *prompt = prompt.replace(original, sanitized);
    }
}
