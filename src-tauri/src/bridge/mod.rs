use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::State,
    response::IntoResponse,
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};

use crate::gateway::server::GatewayState;

/// Messages from the browser extension
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ExtensionMessage {
    /// Extension wants to scan content before pasting
    #[serde(rename = "scan")]
    Scan { content: String, request_id: String },
    /// Extension is reporting that it blocked content
    #[serde(rename = "blocked")]
    Blocked { request_id: String },
    /// Extension health check
    #[serde(rename = "ping")]
    Ping,
}

/// Messages to the browser extension
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum GatewayMessage {
    /// Scan result with detected entities
    #[serde(rename = "scan_result")]
    ScanResult {
        request_id: String,
        has_pii: bool,
        entities: Vec<(String, usize)>,
        sanitized_content: Option<String>,
    },
    /// Pong response
    #[serde(rename = "pong")]
    Pong { version: String, active: bool },
    /// Error
    #[serde(rename = "error")]
    Error { message: String },
}

/// Build the WebSocket router for extension communication.
/// Wired into the gateway with shared state for PII scanning.
pub fn ws_router() -> Router<GatewayState> {
    Router::new().route("/ws", get(ws_handler))
}

async fn ws_handler(ws: WebSocketUpgrade, State(gw): State<GatewayState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, gw))
}

async fn handle_ws(mut socket: WebSocket, gw: GatewayState) {
    tracing::info!("🔌 Browser extension connected via WebSocket");

    while let Some(msg) = socket.recv().await {
        match msg {
            Ok(Message::Text(text)) => {
                let response = handle_extension_message(&text, &gw).await;
                let response_json = serde_json::to_string(&response).unwrap_or_else(|e| {
                    tracing::error!("Failed to serialize response: {}", e);
                    r#"{\"type\":\"error\",\"message\":\"Internal serialization error\"}"#
                        .to_string()
                });

                if socket
                    .send(Message::Text(response_json.into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            Ok(Message::Close(_)) => {
                tracing::info!("🔌 Browser extension disconnected");
                break;
            }
            Err(e) => {
                tracing::warn!("WebSocket error: {}", e);
                break;
            }
            _ => {}
        }
    }
}

async fn handle_extension_message(text: &str, gw: &GatewayState) -> GatewayMessage {
    match serde_json::from_str::<ExtensionMessage>(text) {
        Ok(ExtensionMessage::Scan {
            content,
            request_id,
        }) => {
            // Use the shared PiiEngine (respects user-configured allow/deny lists)
            let pii_engine = gw.pii_engine.read().await;
            let matches = pii_engine.detect(&content).await;
            drop(pii_engine);

            let has_pii = !matches.is_empty();

            let entities: Vec<(String, usize)> = {
                let mut summary = std::collections::HashMap::new();
                for m in &matches {
                    *summary.entry(m.pii_type.to_string()).or_insert(0usize) += 1;
                }
                summary.into_iter().collect()
            };

            let sanitized_content = if has_pii {
                let mut pseudonymizer = crate::pseudonym::Pseudonymizer::new();
                let (sanitized, _) = pseudonymizer.pseudonymize(&content, &matches);
                Some(sanitized)
            } else {
                None
            };

            GatewayMessage::ScanResult {
                request_id,
                has_pii,
                entities,
                sanitized_content,
            }
        }
        Ok(ExtensionMessage::Blocked { .. }) => GatewayMessage::Pong {
            version: env!("CARGO_PKG_VERSION").to_string(),
            active: true,
        },
        Ok(ExtensionMessage::Ping) => GatewayMessage::Pong {
            version: env!("CARGO_PKG_VERSION").to_string(),
            active: true,
        },
        Err(e) => GatewayMessage::Error {
            message: format!("Invalid message: {}", e),
        },
    }
}
