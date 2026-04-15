//! Request forwarding, streaming, and failover logic.

use axum::http::StatusCode;
use axum::response::{sse::Event, IntoResponse, Response, Sse};
use futures::StreamExt;

use crate::gateway::router;
use crate::perf::benchmark::LatencyBuilder;
use crate::pii::recognizers::PiiMatch;
use crate::pseudonym::Pseudonymizer;

use super::pii_handler::body;
use super::server::GatewayState;

// ── Forward Context ─────────────────────────────────────────────────────────

/// Context for forwarding a request to an upstream provider.
pub struct ForwardContext<'a> {
    pub gw: &'a GatewayState,
    pub session_id: &'a str,
    pub upstream_url: &'a str,
    pub api_key: &'a str,
    pub sanitized_body: &'a serde_json::Value,
    pub is_anthropic: bool,
    pub provider_name: &'a str,
    pub model: &'a str,
}

/// Forward a non-streaming request to upstream, rehydrate the response, and record latency.
pub async fn forward_and_rehydrate(
    ctx: ForwardContext<'_>,
    latency: LatencyBuilder,
    is_streaming: bool,
) -> Result<Response, (LatencyBuilder, String)> {
    match crate::gateway::streaming::forward_request(
        &ctx.gw.http_client,
        ctx.upstream_url,
        ctx.api_key,
        ctx.sanitized_body,
        ctx.is_anthropic,
    )
    .await
    {
        Ok(response) => Ok(super::pii_handler::rehydrate_response(
            ctx.gw,
            latency,
            ctx.session_id,
            &response,
            is_streaming,
            ctx.provider_name,
            ctx.model,
        )
        .await),
        Err(e) => Err((latency, e.to_string())),
    }
}

// ── Streaming Handler ───────────────────────────────────────────────────────

/// Handle the streaming response path: forward as SSE and rehydrate each chunk.
#[allow(clippy::too_many_arguments)]
pub async fn handle_streaming(
    gw: GatewayState,
    mut latency: LatencyBuilder,
    session_id: String,
    upstream_url: String,
    api_key: String,
    sanitized_body: serde_json::Value,
    is_anthropic: bool,
    provider_name: &str,
    model: &str,
) -> Response {
    let session_id_for_rehydrate = session_id.clone();
    let app_state_for_rehydrate = gw.app_state.clone();

    let stream = crate::gateway::streaming::forward_streaming_request_raw(
        gw.http_client.clone(),
        upstream_url,
        api_key,
        sanitized_body,
        is_anthropic,
    );

    // Record latency for streaming
    latency.upstream_done();
    latency.rehydrate_start();
    latency.rehydrate_done();
    {
        let tracker = gw.app_state.read().await.latency_benchmark.clone();
        tracker.record(latency.build(true, provider_name.to_string(), model.to_string()));
    }

    // Rehydrate SSE events in the stream
    let rehydrated_stream = async_stream::stream! {
        futures::pin_mut!(stream);
        while let Some(result) = stream.next().await {
            let data_str = result.unwrap_or_default();
            if data_str.is_empty() {
                continue;
            }

            let rehydrated_chunk = super::pii_handler::rehydrate_sse_chunk(
                &app_state_for_rehydrate,
                &session_id_for_rehydrate,
                data_str,
            ).await;

            yield Ok::<_, std::convert::Infallible>(Event::default().data(rehydrated_chunk));
        }
    };

    Sse::new(Box::pin(rehydrated_stream))
        .keep_alive(axum::response::sse::KeepAlive::default())
        .into_response()
}

// ── Failover ────────────────────────────────────────────────────────────────

/// Context needed for failover routing.
pub struct FailoverContext<'a> {
    pub gw: &'a GatewayState,
    pub latency: LatencyBuilder,
    pub session_id: &'a str,
    pub body: &'a serde_json::Value,
    pub text_content: &'a str,
    pub matches: &'a [PiiMatch],
    pub primary_error: &'a str,
    pub primary_provider: &'a crate::config::ProviderConfig,
    pub model: &'a str,
}

/// Attempt failover to an alternative provider when the primary fails.
pub async fn try_failover(ctx: FailoverContext<'_>) -> Response {
    // Look up failover provider
    let failover_provider = {
        let app_state = ctx.gw.app_state.read().await;
        router::find_failover_provider(&app_state.providers, &ctx.primary_provider.name, ctx.model)
            .cloned()
    };

    let Some(failover_provider) = failover_provider else {
        return bad_gateway_response(ctx.primary_error);
    };

    let Ok(failover_key) = router::get_provider_api_key(&failover_provider.name) else {
        return (
            StatusCode::BAD_GATEWAY,
            axum::Json(serde_json::json!({
                "error": format!("Primary failed: {}. Failover key unavailable.", ctx.primary_error)
            })),
        )
            .into_response();
    };

    let failover_url = router::build_upstream_url(&failover_provider);
    let is_failover_anthropic = failover_provider.name.to_lowercase().contains("anthropic");
    let is_primary_anthropic = ctx
        .primary_provider
        .name
        .to_lowercase()
        .contains("anthropic");

    // Re-pseudonymize when the failover provider uses a different format family
    let failover_body = if is_failover_anthropic != is_primary_anthropic && !ctx.matches.is_empty()
    {
        let mut pseudonymizer = Pseudonymizer::new();
        let (sanitized_text, _) = pseudonymizer.pseudonymize(ctx.text_content, ctx.matches);
        let mut fb = ctx.body.clone();
        body::replace_text_in_body(&mut fb, ctx.text_content, &sanitized_text);
        fb
    } else {
        ctx.body.clone()
    };

    match crate::gateway::streaming::forward_request(
        &ctx.gw.http_client,
        &failover_url,
        &failover_key,
        &failover_body,
        is_failover_anthropic,
    )
    .await
    {
        Ok(response) => {
            super::pii_handler::rehydrate_response(
                ctx.gw,
                ctx.latency,
                ctx.session_id,
                &response,
                false,
                &failover_provider.name,
                ctx.model,
            )
            .await
        }
        Err(fe) => (
            StatusCode::BAD_GATEWAY,
            axum::Json(serde_json::json!({
                "error": format!("Primary and failover both failed: {} | {}", ctx.primary_error, fe)
            })),
        )
            .into_response(),
    }
}

fn bad_gateway_response(error: &str) -> Response {
    (
        StatusCode::BAD_GATEWAY,
        axum::Json(serde_json::json!({ "error": error })),
    )
        .into_response()
}
