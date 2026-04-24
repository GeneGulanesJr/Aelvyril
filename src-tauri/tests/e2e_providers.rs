//! End-to-end tests against real upstream providers.
//!
//! These tests are opt-in and require environment variables:
//!   AELVYRIL_E2E_OPENAI_KEY — OpenAI API key
//!   AELVYRIL_E2E_ANTHROPIC_KEY — Anthropic API key
//!   AELVYRIL_E2E_GATEWAY_URL — Gateway URL (default: http://localhost:18234)
//!   AELVYRIL_E2E_GATEWAY_KEY — Gateway API key
//!
//! Run with: cargo test --test e2e_providers -- --ignored

use serde_json::json;

/// Helper to get an OpenAI API key from env or skip the test.
fn openai_key() -> Option<String> {
    std::env::var("AELVYRIL_E2E_OPENAI_KEY").ok()
}

/// Helper to get an Anthropic API key from env or skip the test.
fn anthropic_key() -> Option<String> {
    std::env::var("AELVYRIL_E2E_ANTHROPIC_KEY").ok()
}

fn openai_base_url() -> &'static str {
    "https://api.openai.com/v1"
}

fn anthropic_base_url() -> &'static str {
    "https://api.anthropic.com/v1"
}

#[tokio::test]
#[ignore]
async fn test_openai_non_streaming_chat() {
    let key = openai_key().expect("AELVYRIL_E2E_OPENAI_KEY not set");

    let client = reqwest::Client::new();
    let body = json!({
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "Say hello in one word."}],
        "max_tokens": 10
    });

    let resp = client
        .post(format!("{}/chat/completions", openai_base_url()))
        .header("Authorization", format!("Bearer {}", key))
        .json(&body)
        .send()
        .await
        .expect("Request failed");

    assert!(
        resp.status().is_success(),
        "OpenAI returned status: {}",
        resp.status()
    );

    let json: serde_json::Value = resp.json().await.unwrap();
    let content = json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");
    assert!(!content.is_empty(), "Response should not be empty");
}

#[tokio::test]
#[ignore]
async fn test_openai_streaming_chat() {
    let key = openai_key().expect("AELVYRIL_E2E_OPENAI_KEY not set");

    let client = reqwest::Client::new();
    let body = json!({
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "Count from 1 to 3."}],
        "max_tokens": 20,
        "stream": true
    });

    let resp = client
        .post(format!("{}/chat/completions", openai_base_url()))
        .header("Authorization", format!("Bearer {}", key))
        .json(&body)
        .send()
        .await
        .expect("Request failed");

    assert!(resp.status().is_success(), "OpenAI returned status: {}", resp.status());

    let text = resp.text().await.unwrap();
    assert!(text.contains("data:"), "Should contain SSE data lines");
    assert!(text.contains("[DONE]"), "Should end with [DONE]");
}

#[tokio::test]
#[ignore]
async fn test_anthropic_non_streaming_chat() {
    let key = anthropic_key().expect("AELVYRIL_E2E_ANTHROPIC_KEY not set");

    let client = reqwest::Client::new();
    let body = json!({
        "model": "claude-sonnet-4-20250514",
        "messages": [{"role": "user", "content": "Say hello in one word."}],
        "max_tokens": 10
    });

    let resp = client
        .post(format!("{}/messages", anthropic_base_url()))
        .header("x-api-key", &key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .expect("Request failed");

    assert!(
        resp.status().is_success(),
        "Anthropic returned status: {}",
        resp.status()
    );

    let json: serde_json::Value = resp.json().await.unwrap();
    let content = json["content"][0]["text"].as_str().unwrap_or("");
    assert!(!content.is_empty(), "Response should not be empty");
}

#[tokio::test]
#[ignore]
async fn test_anthropic_streaming_chat() {
    let key = anthropic_key().expect("AELVYRIL_E2E_ANTHROPIC_KEY not set");

    let client = reqwest::Client::new();
    let body = json!({
        "model": "claude-sonnet-4-20250514",
        "messages": [{"role": "user", "content": "Count from 1 to 3."}],
        "max_tokens": 20,
        "stream": true
    });

    let resp = client
        .post(format!("{}/messages", anthropic_base_url()))
        .header("x-api-key", &key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .expect("Request failed");

    assert!(resp.status().is_success(), "Anthropic returned status: {}", resp.status());

    let text = resp.text().await.unwrap();
    assert!(text.contains("data:"), "Should contain SSE data lines");
}

#[tokio::test]
#[ignore]
async fn test_gateway_pii_rehydration_pipeline() {
    let gateway_url =
        std::env::var("AELVYRIL_E2E_GATEWAY_URL").unwrap_or_else(|_| "http://localhost:18234".into());
    let gateway_key =
        std::env::var("AELVYRIL_E2E_GATEWAY_KEY").expect("AELVYRIL_E2E_GATEWAY_KEY not set");

    let client = reqwest::Client::new();
    let body = json!({
        "model": "gpt-4o-mini",
        "messages": [{
            "role": "user",
            "content": "My email is user@example.com and my SSN is 123-45-6789. Please repeat them back exactly."
        }],
        "max_tokens": 100
    });

    let resp = client
        .post(format!("{}/v1/chat/completions", gateway_url))
        .header("Authorization", format!("Bearer {}", gateway_key))
        .json(&body)
        .send()
        .await
        .expect("Gateway request failed");

    assert!(
        resp.status().is_success(),
        "Gateway returned status: {}",
        resp.status()
    );

    let json: serde_json::Value = resp.json().await.unwrap();
    let content = json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");

    // The gateway should have rehydrated the PII tokens back to original values
    assert!(
        content.contains("user@example.com"),
        "PII should be rehydrated in response. Got: {}",
        content
    );
}

#[tokio::test]
#[ignore]
async fn test_gateway_streaming_with_pii() {
    let gateway_url =
        std::env::var("AELVYRIL_E2E_GATEWAY_URL").unwrap_or_else(|_| "http://localhost:18234".into());
    let gateway_key =
        std::env::var("AELVYRIL_E2E_GATEWAY_KEY").expect("AELVYRIL_E2E_GATEWAY_KEY not set");

    let client = reqwest::Client::new();
    let body = json!({
        "model": "gpt-4o-mini",
        "messages": [{
            "role": "user",
            "content": "Repeat this exactly: email is test@pii.com"
        }],
        "max_tokens": 50,
        "stream": true
    });

    let resp = client
        .post(format!("{}/v1/chat/completions", gateway_url))
        .header("Authorization", format!("Bearer {}", gateway_key))
        .json(&body)
        .send()
        .await
        .expect("Gateway request failed");

    assert!(resp.status().is_success(), "Gateway returned status: {}", resp.status());

    let text = resp.text().await.unwrap();

    // Verify SSE structure is preserved
    assert!(text.contains("data:"), "Should contain SSE data lines");
    assert!(text.contains("[DONE]"), "Should end with [DONE]");

    // Verify PII rehydrated in streamed output
    assert!(
        text.contains("test@pii.com"),
        "PII should be rehydrated in streaming output"
    );
}
