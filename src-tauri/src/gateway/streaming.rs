use axum::response::sse::Event;
use futures::Stream;
use reqwest::Client;
use std::convert::Infallible;
use tokio_stream::StreamExt;

/// Forward a non-streaming request to the upstream provider
pub async fn forward_request(
    client: &Client,
    url: &str,
    api_key: &str,
    body: &serde_json::Value,
    is_anthropic: bool,
) -> Result<serde_json::Value, String> {
    let mut req = client.post(url);

    if is_anthropic {
        req = req
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json");
    } else {
        req = req
            .header("Authorization", format!("Bearer {}", api_key))
            .header("content-type", "application/json");
    }

    let resp = req
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Upstream request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Upstream returned {}: {}", status, body));
    }

    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Failed to parse upstream response: {}", e))
}

/// Forward a streaming SSE request to the upstream provider.
/// Returns a stream of SSE events from the upstream.
pub fn forward_streaming_request(
    client: Client,
    url: String,
    api_key: String,
    body: serde_json::Value,
    is_anthropic: bool,
) -> impl Stream<Item = Result<Event, Infallible>> {
    let mut req = client.post(&url);

    if is_anthropic {
        req = req
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json");
    } else {
        req = req
            .header("Authorization", format!("Bearer {}", api_key))
            .header("content-type", "application/json");
    }

    async_stream::stream! {
        match reqwest_eventsource::EventSource::new(req.json(&body)) {
            Ok(mut stream) => {
                while let Some(event) = stream.next().await {
                    match event {
                        Ok(reqwest_eventsource::Event::Open) => continue,
                        Ok(reqwest_eventsource::Event::Message(message)) => {
                            yield Ok(Event::default().data(message.data));
                        }
                        Err(e) => {
                            tracing::warn!("SSE stream error: {}", e);
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                yield Ok(Event::default().data(format!(
                    "{{\"error\": \"Failed to create EventSource: {}\"}}",
                    e
                )));
            }
        }
    }
}

/// Forward a streaming SSE request, yielding raw data strings instead of Events.
/// This allows callers (e.g., server.rs) to rehydrate the data before wrapping
/// it in an SSE Event.
pub fn forward_streaming_request_raw(
    client: Client,
    url: String,
    api_key: String,
    body: serde_json::Value,
    is_anthropic: bool,
) -> impl Stream<Item = Result<String, Infallible>> {
    let mut req = client.post(&url);

    if is_anthropic {
        req = req
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json");
    } else {
        req = req
            .header("Authorization", format!("Bearer {}", api_key))
            .header("content-type", "application/json");
    }

    async_stream::stream! {
        match reqwest_eventsource::EventSource::new(req.json(&body)) {
            Ok(mut stream) => {
                while let Some(event) = stream.next().await {
                    match event {
                        Ok(reqwest_eventsource::Event::Open) => continue,
                        Ok(reqwest_eventsource::Event::Message(message)) => {
                            yield Ok(message.data);
                        }
                        Err(e) => {
                            tracing::warn!("SSE stream error: {}", e);
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                yield Ok(format!(
                    "{{\"error\": \"Failed to create EventSource: {}\"}}",
                    e
                ));
            }
        }
    }
}
