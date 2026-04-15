//! PII detection and pseudonymization helpers for the gateway pipeline.

use crate::perf::benchmark::LatencyBuilder;
use crate::pii::recognizers::PiiMatch;
use crate::pseudonym::{Pseudonymizer, Rehydrator};
use crate::AppState;

use super::server::GatewayState;

// ── PII Detection ───────────────────────────────────────────────────────────

/// Detect PII in the text content, using the cache when available.
pub async fn detect_pii(
    gw: &GatewayState,
    latency: &mut LatencyBuilder,
    text_content: &str,
) -> Vec<PiiMatch> {
    latency.pii_start();
    let pii_cache = gw.app_state.read().await.pii_cache.clone();

    if let Some(cached_matches) = pii_cache.get(text_content) {
        latency.pii_done();
        return cached_matches;
    }

    let pii_engine = gw.pii_engine.read().await;
    let detected = pii_engine.detect(text_content).await;
    drop(pii_engine);

    pii_cache.insert(text_content, detected.clone());
    latency.pii_done();
    detected
}

// ── Pseudonymization ────────────────────────────────────────────────────────

/// Pseudonymize the request body and store mappings in the session.
pub fn pseudonymize_and_store(
    app_state: &tokio::sync::RwLockReadGuard<'_, AppState>,
    latency: &mut LatencyBuilder,
    session_id: &str,
    body: &serde_json::Value,
    text_content: &str,
    matches: &[PiiMatch],
) -> serde_json::Value {
    latency.pseudo_start();

    let (sanitized_body, mappings) = if matches.is_empty() {
        (body.clone(), Vec::new())
    } else {
        let mut pseudonymizer = Pseudonymizer::new();
        let (sanitized_text, mappings) = pseudonymizer.pseudonymize(text_content, matches);
        let mut sanitized_body = body.clone();
        body::replace_text_in_body(&mut sanitized_body, text_content, &sanitized_text);
        (sanitized_body, mappings)
    };

    if !mappings.is_empty() {
        app_state.session_manager.with_mapping_table(
            session_id,
            |table: &mut crate::pseudonym::mapping::MappingTable| {
                table.add_mappings(mappings);
            },
        );
    }

    latency.pseudo_done();
    sanitized_body
}

// ── Rehydration ─────────────────────────────────────────────────────────────

/// Rehydrate a non-streaming response by replacing pseudonymized tokens with originals.
/// Consumes the latency builder to record timing.
pub async fn rehydrate_response(
    gw: &GatewayState,
    mut latency: LatencyBuilder,
    session_id: &str,
    response: &serde_json::Value,
    is_streaming: bool,
    provider_name: &str,
    model: &str,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    use axum::Json;

    latency.upstream_done();
    latency.rehydrate_start();

    let rehydrated = gw
        .app_state
        .read()
        .await
        .session_manager
        .with_mapping_table(
            session_id,
            |table: &mut crate::pseudonym::mapping::MappingTable| {
                let response_str = serde_json::to_string(response).unwrap_or_default();
                Rehydrator::rehydrate(&response_str, table)
            },
        )
        .unwrap_or_else(|| serde_json::to_string(response).unwrap_or_default());

    latency.rehydrate_done();
    {
        let tracker = gw.app_state.read().await.latency_benchmark.clone();
        tracker.record(latency.build(is_streaming, provider_name.to_string(), model.to_string()));
    }

    match serde_json::from_str::<serde_json::Value>(&rehydrated) {
        Ok(json) => Json(json).into_response(),
        Err(_) => Json(response.clone()).into_response(),
    }
}

/// Rehydrate a single SSE chunk in-place.
pub async fn rehydrate_sse_chunk(
    app_state: &std::sync::Arc<tokio::sync::RwLock<AppState>>,
    session_id: &str,
    data_str: String,
) -> String {
    app_state
        .read()
        .await
        .session_manager
        .with_mapping_table(
            session_id,
            |table: &mut crate::pseudonym::mapping::MappingTable| {
                Rehydrator::rehydrate_sse_chunk(&data_str, table)
            },
        )
        .unwrap_or(data_str)
}

// ── Body Helpers ────────────────────────────────────────────────────────────

pub mod body {
    /// Extract text content from the request body for PII scanning.
    pub fn extract_text_from_body(body: &serde_json::Value) -> String {
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

    /// Replace text content in the JSON body with sanitized version.
    ///
    /// `original` is the concatenated text from all messages (separated by `\n`),
    /// and `sanitized` is the pseudonymized version of that same concatenated text.
    pub fn replace_text_in_body(body: &mut serde_json::Value, original: &str, sanitized: &str) {
        if original == sanitized {
            return;
        }

        let sanitized_segments: Vec<&str> = sanitized.split('\n').collect();

        if let Some(messages) = body.get_mut("messages").and_then(|m| m.as_array_mut()) {
            let mut seg_idx = 0;
            for message in messages {
                if let Some(content) = message.get_mut("content") {
                    match content {
                        serde_json::Value::String(s) => {
                            if seg_idx < sanitized_segments.len() {
                                *s = sanitized_segments[seg_idx].to_string();
                            }
                            seg_idx += 1;
                        }
                        serde_json::Value::Array(parts) => {
                            if seg_idx < sanitized_segments.len() {
                                replace_multipart_content(parts, sanitized_segments[seg_idx]);
                            }
                            seg_idx += 1;
                        }
                        _ => {}
                    }
                }
            }
        }

        // Handle prompt field (if present, it's the last segment)
        if let Some(serde_json::Value::String(prompt)) = body.get_mut("prompt") {
            let prompt_seg_idx = original.split('\n').count().saturating_sub(1);
            if prompt_seg_idx < sanitized_segments.len() {
                *prompt = sanitized_segments[prompt_seg_idx].to_string();
            }
        }
    }

    /// Replace text in a multi-part content array with the corresponding sanitized segment.
    fn replace_multipart_content(parts: &mut [serde_json::Value], sanitized_text: &str) {
        let text_parts: Vec<&str> = parts
            .iter()
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect();

        if text_parts.len() <= 1 {
            // Single text part (or none) — replace directly
            for part in parts.iter_mut() {
                if let Some(serde_json::Value::String(text)) = part.get_mut("text") {
                    *text = sanitized_text.to_string();
                }
            }
        } else {
            // Multiple text parts — distribute across parts
            let sanitized_parts: Vec<&str> = sanitized_text.split('\n').collect();
            let mut part_idx = 0;
            for part in parts.iter_mut() {
                if part.get("text").map_or(false, |t| t.is_string()) {
                    if let Some(serde_json::Value::String(t)) = part.get_mut("text") {
                        if part_idx < sanitized_parts.len() {
                            *t = sanitized_parts[part_idx].to_string();
                        }
                    }
                    part_idx += 1;
                }
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn test_extract_text_simple_messages() {
            let body = serde_json::json!({
                "messages": [
                    { "role": "user", "content": "Hello world" },
                    { "role": "assistant", "content": "Hi there" }
                ]
            });
            let text = extract_text_from_body(&body);
            assert_eq!(text, "Hello world\nHi there\n");
        }

        #[test]
        fn test_extract_text_multipart_content() {
            let body = serde_json::json!({
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            { "type": "text", "text": "Part one" },
                            { "type": "image", "url": "..." }
                        ]
                    }
                ]
            });
            let text = extract_text_from_body(&body);
            assert!(text.contains("Part one"));
        }

        #[test]
        fn test_extract_text_prompt_field() {
            let body = serde_json::json!({ "prompt": "My prompt here" });
            let text = extract_text_from_body(&body);
            assert_eq!(text, "My prompt here\n");
        }

        #[test]
        fn test_replace_text_no_change() {
            let mut body = serde_json::json!({
                "messages": [{ "role": "user", "content": "Hello" }]
            });
            let original = "Hello\n";
            let sanitized = "Hello\n";
            replace_text_in_body(&mut body, original, sanitized);
            assert_eq!(body["messages"][0]["content"], "Hello");
        }

        #[test]
        fn test_replace_text_simple() {
            let mut body = serde_json::json!({
                "messages": [{ "role": "user", "content": "email@test.com" }]
            });
            let original = "email@test.com\n";
            let sanitized = "[Email_1]\n";
            replace_text_in_body(&mut body, original, sanitized);
            assert_eq!(body["messages"][0]["content"], "[Email_1]");
        }
    }
}
