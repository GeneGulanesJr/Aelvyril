//! Request forwarding, streaming, and failover logic.

use axum::http::StatusCode;
use axum::response::{sse::Event, IntoResponse, Response, Sse};
use futures::StreamExt;
use std::sync::Arc;

use crate::gateway::router;
use crate::perf::benchmark::LatencyBuilder;
use crate::pii::recognizers::PiiMatch;
use crate::pseudonym::Pseudonymizer;
use crate::token_usage::{pricing, TokenCountSource};
use crate::token_usage::tracker::TokenUsageTracker;

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
    let request_start = std::time::Instant::now();
    match crate::gateway::streaming::forward_request(
        &ctx.gw.http_client,
        ctx.upstream_url,
        ctx.api_key,
        ctx.sanitized_body,
        ctx.is_anthropic,
    )
    .await
    {
        Ok(response) => {
            // Record token usage from the raw API response before rehydration.
            // The response<serde_json::Value> contains the `usage` field
            // with prompt/completion token counts.
            let duration_ms = request_start.elapsed().as_millis() as u64;
            let tracker = ctx.gw.app_state.read().await.token_usage_tracker.clone();
            let event = crate::token_usage::tracker::TokenUsageTracker::new_from_response(
                ctx.session_id,
                ctx.model,
                "chat_completions",
                duration_ms,
                &response,
                ctx.is_anthropic,
                is_streaming,
            );
            tracker.record(event);

            Ok(super::pii_handler::rehydrate_response(
                ctx.gw,
                latency,
                ctx.session_id,
                &response,
                is_streaming,
                ctx.provider_name,
                ctx.model,
            )
            .await)
        }
        Err(e) => Err((latency, e.to_string())),
    }
}

// ── Streaming Handler ───────────────────────────────────────────────────────

/// Handle the streaming response path: forward as SSE and rehydrate each chunk.
/// After the stream completes, parses the final usage chunk (enabled via
/// `stream_options.include_usage`) and records actual token counts to the
/// tracker. Falls back to Estimated counts if no usage data arrives.
#[allow(clippy::too_many_arguments)]
pub async fn handle_streaming(
    gw: GatewayState,
    latency: LatencyBuilder,
    session_id: String,
    upstream_url: String,
    api_key: String,
    sanitized_body: serde_json::Value,
    is_anthropic: bool,
    provider_name: &str,
    model: &str,
) -> Response {
    let request_start = std::time::Instant::now();
    let session_id_for_rehydrate = session_id.clone();
    let app_state_for_rehydrate = std::sync::Arc::clone(&gw.app_state);

    let stream = crate::gateway::streaming::forward_streaming_request_raw(
        gw.http_client.clone(),
        upstream_url,
        api_key,
        sanitized_body,
        is_anthropic,
    );

    record_streaming_latency(&gw, latency, provider_name, model).await;

    // Capture the last SSE chunk that contains usage data for token recording.
    let last_usage_chunk: Arc<parking_lot::Mutex<Option<String>>> = Arc::new(parking_lot::Mutex::new(None));
    let last_usage_chunk_clone = Arc::clone(&last_usage_chunk);

    // Prepare data for post-stream token recording
    let tracker_for_post = gw.app_state.read().await.token_usage_tracker.clone();
    let session_id_for_post = session_id.clone();
    let model_for_post = model.to_string();

    let rehydrated_stream = build_rehydrated_stream(
        stream,
        app_state_for_rehydrate,
        session_id_for_rehydrate,
        last_usage_chunk_clone,
        is_anthropic,
        request_start,
        tracker_for_post,
        session_id_for_post,
        model_for_post,
    );

    Sse::new(Box::pin(rehydrated_stream))
        .keep_alive(axum::response::sse::KeepAlive::default())
        .into_response()
}

/// Record latency benchmark for a streaming request.
async fn record_streaming_latency(
    gw: &GatewayState,
    latency: LatencyBuilder,
    provider_name: &str,
    model: &str,
) {
    let tracker = gw.app_state.read().await.latency_benchmark.clone();
    tracker.record(latency.build(true, provider_name.to_string(), model.to_string()));
}

/// Check if an SSE chunk contains usage/token data.
fn is_usage_chunk(data: &str, is_anthropic: bool) -> bool {
    if data == "[DONE]" {
        return false;
    }
    if is_anthropic {
        data.contains("\"message_stop\"") || data.contains("\"usage\"")
    } else {
        data.contains("\"usage\"")
    }
}

/// Build the rehydrated SSE stream that tracks the last usage chunk and
/// records a token-usage event after the stream completes.
///
/// If the stream ends without a final usage chunk (partial disconnect),
/// the event is marked as `was_partial = true` with estimated token counts.
#[allow(clippy::too_many_arguments)]
fn build_rehydrated_stream(
    stream: impl futures::Stream<Item = Result<String, std::convert::Infallible>> + Send + 'static,
    app_state: std::sync::Arc<tokio::sync::RwLock<crate::AppState>>,
    session_id: String,
    last_usage_chunk: Arc<parking_lot::Mutex<Option<String>>>,
    is_anthropic: bool,
    request_start: std::time::Instant,
    tracker: Arc<TokenUsageTracker>,
    session_id_for_post: String,
    model_for_post: String,
) -> impl futures::Stream<Item = Result<Event, std::convert::Infallible>> + Send + 'static {
    async_stream::stream! {
        futures::pin_mut!(stream);
        let mut stream_ended_normally = false;
        let mut chunk_count: u64 = 0;

        while let Some(result) = stream.next().await {
            let data_str = result.unwrap_or_default();
            if data_str.is_empty() {
                continue;
            }
            chunk_count += 1;

            // Check for stream completion markers
            if data_str.trim() == "data: [DONE]" || data_str.trim() == "[DONE]" {
                stream_ended_normally = true;
            }

            if is_usage_chunk(&data_str, is_anthropic) {
                let mut last = last_usage_chunk.lock();
                *last = Some(data_str.clone());
            }

            let rehydrated_chunk = super::pii_handler::rehydrate_sse_chunk(
                &app_state,
                &session_id,
                data_str,
            ).await;

            yield Ok::<_, std::convert::Infallible>(Event::default().data(rehydrated_chunk));
        }

        // Post-stream: record token usage from the captured usage chunk
        let duration_ms = request_start.elapsed().as_millis() as u64;
        let final_usage = last_usage_chunk.lock().take();

        // If the stream didn't end normally AND we got no usage chunk,
        // this was a partial disconnect — mark was_partial = true
        // Even if we got some chunks, if no [DONE] was received and no
        // usage data, it's likely a partial stream.
        let was_partial = !stream_ended_normally && final_usage.is_none();
        // Also consider it partial if we got very few chunks and no usage
        let was_partial = was_partial || (chunk_count < 3 && final_usage.is_none());

        let event = build_post_stream_event(
            final_usage.as_deref(),
            &model_for_post,
            &session_id_for_post,
            is_anthropic,
            duration_ms,
            was_partial,
        );
        tracker.record(event);
    }
}

/// Build a `TokenUsageEvent` from the final usage chunk captured during streaming.
///
/// When `was_partial` is true, it indicates the stream disconnected before
/// the [DONE] marker or final usage chunk was received.
fn build_post_stream_event(
    final_usage: Option<&str>,
    model: &str,
    session_id: &str,
    is_anthropic: bool,
    duration_ms: u64,
    was_partial: bool,
) -> crate::token_usage::TokenUsageEvent {
    let (tokens_in_system, tokens_in_user, tokens_in_cached, tokens_out, token_count_source) =
        match final_usage {
            Some(chunk) => extract_streaming_usage(chunk, model, is_anthropic),
            None => {
                (pricing::estimate_system_tokens(model), 0, 0, 0, TokenCountSource::Estimated)
            }
        };

    crate::token_usage::tracker::TokenUsageTracker::build_event(
        session_id,
        "chat_completions",
        model,
        tokens_in_system,
        tokens_in_user,
        tokens_in_cached,
        tokens_out,
        0,  // tokens_truncated
        true,  // was_streamed
        was_partial, // was_partial: true if stream disconnected early
        duration_ms,
        tokens_out > 0, // success: at least some output received
        token_count_source,
        0,  // retry_attempt
    )
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

/// Extract token counts from a streaming SSE usage chunk.
///
/// OpenAI sends a final chunk with `usage` when `stream_options.include_usage`
/// is set. Anthropic includes usage in the `message_stop` event.
fn extract_streaming_usage(
    chunk: &str,
    model: &str,
    is_anthropic: bool,
) -> (u64, u64, u64, u64, TokenCountSource) {
    // SSE chunks are prefixed with "data: " — strip that and try to parse as JSON.
    // The chunk may contain multiple JSON objects separated by newlines.
    // We try each line until we find one with a `usage` field.
    for line in chunk.lines() {
        let line = line.strip_prefix("data: ").unwrap_or(line).trim();
        if line.is_empty() || line == "[DONE]" {
            continue;
        }

        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) {
            let usage = if is_anthropic {
                parsed.get("usage").or_else(|| parsed.get("delta").and_then(|d| d.get("usage")))
            } else {
                parsed.get("usage")
            };

            if let Some(usage_data) = usage {
                if let Some(result) = extract_usage_tokens(usage_data, model, is_anthropic) {
                    return result;
                }
            }
        }
    }

    // No usable usage data found — fall back to estimated
    (pricing::estimate_system_tokens(model), 0, 0, 0, TokenCountSource::Estimated)
}

/// Extract token counts from a parsed `usage` JSON object.
/// Returns `Some((sys, user, cached, out, source))` if the data is usable, `None` otherwise.
fn extract_usage_tokens(
    usage: &serde_json::Value,
    model: &str,
    is_anthropic: bool,
) -> Option<(u64, u64, u64, u64, TokenCountSource)> {
    if is_anthropic {
        extract_anthropic_usage_tokens(usage, model)
    } else {
        extract_openai_usage_tokens(usage, model)
    }
}

/// Parse Anthropic-style `usage` fields and compute token breakdown.
fn extract_anthropic_usage_tokens(
    usage: &serde_json::Value,
    model: &str,
) -> Option<(u64, u64, u64, u64, TokenCountSource)> {
    let input_tokens = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
    let output_tokens = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
    let cache_read = usage.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);

    if input_tokens == 0 && output_tokens == 0 {
        return None;
    }

    let sys = pricing::estimate_system_tokens(model);
    let user = if input_tokens > sys { input_tokens - sys } else { input_tokens };
    Some((sys, user, cache_read, output_tokens, TokenCountSource::ApiReported))
}

/// Parse OpenAI-style `usage` fields and compute token breakdown.
fn extract_openai_usage_tokens(
    usage: &serde_json::Value,
    model: &str,
) -> Option<(u64, u64, u64, u64, TokenCountSource)> {
    let prompt_tokens = usage.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
    let completion_tokens = usage.get("completion_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
    let cached_tokens = usage
        .get("prompt_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    if prompt_tokens == 0 && completion_tokens == 0 {
        return None;
    }

    let sys = pricing::estimate_system_tokens(model);
    let user = if prompt_tokens > sys { prompt_tokens - sys } else { prompt_tokens };
    Some((sys, user, cached_tokens, completion_tokens, TokenCountSource::ApiReported))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_streaming_usage_openai() {
        let chunk = r#"data: {"id":"chatcmpl-123","object":"chat.completion.chunk","usage":{"prompt_tokens":1500,"completion_tokens":200,"total_tokens":1700}}"#;
        let (sys, _user, cached, out, source) = extract_streaming_usage(chunk, "gpt-4o", false);
        assert_eq!(source, TokenCountSource::ApiReported);
        assert!(sys > 0, "system tokens should be estimated: {}", sys);
        assert_eq!(out, 200);
        assert_eq!(cached, 0);
    }

    #[test]
    fn test_extract_streaming_usage_openai_with_cache() {
        let chunk = r#"data: {"id":"chatcmpl-123","object":"chat.completion.chunk","usage":{"prompt_tokens":1500,"completion_tokens":200,"total_tokens":1700,"prompt_tokens_details":{"cached_tokens":500}}}"#;
        let (_sys, _user, cached, out, source) = extract_streaming_usage(chunk, "gpt-4o", false);
        assert_eq!(source, TokenCountSource::ApiReported);
        assert_eq!(out, 200);
        assert_eq!(cached, 500);
    }

    #[test]
    fn test_extract_streaming_usage_anthropic() {
        let chunk = r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":150}}"#;
        let (sys, _user, _cached, out, source) = extract_streaming_usage(chunk, "claude-3-5-sonnet", true);
        assert_eq!(source, TokenCountSource::ApiReported);
        assert!(sys > 0);
        assert_eq!(out, 150);
    }

    #[test]
    fn test_extract_streaming_usage_no_data() {
        // Chunk without usage — should fall back to estimated
        let chunk = r#"data: {"id":"chatcmpl-123","choices":[{"delta":{"content":"hello"}}]}"#;
        let (sys, user, _cached, out, source) = extract_streaming_usage(chunk, "gpt-4o", false);
        assert_eq!(source, TokenCountSource::Estimated);
        assert!(sys > 0);
        assert_eq!(user, 0);
        assert_eq!(out, 0);
    }

    #[test]
    fn test_extract_streaming_usage_multiline() {
        // Multiple lines in one chunk, usage is on the last line
        let chunk = r#"data: {"id":"chatcmpl-123","choices":[{"delta":{"content":"hi"}}]}
data: {"id":"chatcmpl-123","usage":{"prompt_tokens":1000,"completion_tokens":50,"total_tokens":1050}}"#;
        let (_sys, _user, _cached, out, source) = extract_streaming_usage(chunk, "gpt-4o", false);
        assert_eq!(source, TokenCountSource::ApiReported);
        assert_eq!(out, 50);
    }

    #[test]
    fn test_extract_streaming_usage_done_marker() {
        // [DONE] should be skipped, but earlier data with usage should be found
        let chunk = r#"data: {"usage":{"prompt_tokens":800,"completion_tokens":100}}"#;
        let (_sys, _user, _cached, out, source) = extract_streaming_usage(chunk, "gpt-4o", false);
        assert_eq!(source, TokenCountSource::ApiReported);
        assert_eq!(out, 100);
    }
}
