/**
 * Aelvyril Browser Extension — Background Service Worker
 *
 * Manages WebSocket connection to the Aelvyril desktop app.
 * Handles scanning requests from content scripts and
 * returns scan results.
 */

const GATEWAY_WS_URL = "ws://localhost:4242/ws";
const GATEWAY_HTTP_URL = "http://localhost:4242";

let ws = null;
let reconnectTimer = null;

// ── WebSocket Connection ──────────────────────────────────────────────────

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  try {
    ws = new WebSocket(GATEWAY_WS_URL);

    ws.onopen = () => {
      console.log("[Aelvyril] Connected to desktop app");
      chrome.runtime.sendMessage({ type: "connection_status", connected: true }).catch(() => {});
    };

    ws.onclose = () => {
      console.log("[Aelvyril] Disconnected from desktop app");
      chrome.runtime.sendMessage({ type: "connection_status", connected: false }).catch(() => {});
      scheduleReconnect();
    };

    ws.onerror = () => {
      scheduleReconnect();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "scan_result") {
          // Forward to content script
          chrome.runtime
            .sendMessage({
              type: "scan_result",
              requestId: msg.request_id,
              hasPii: msg.has_pii,
              entities: msg.entities,
              sanitizedContent: msg.sanitized_content,
            })
            .catch(() => {});
        }
      } catch (e) {
        console.error("[Aelvyril] Failed to parse message:", e);
      }
    };
  } catch (e) {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 3000);
}

// ── Message Handling ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "scan") {
    // Try WebSocket first, fall back to HTTP
    if (ws && ws.readyState === WebSocket.OPEN) {
      const request = {
        type: "scan",
        content: message.content,
        request_id: message.requestId || crypto.randomUUID(),
      };
      ws.send(JSON.stringify(request));
      sendResponse({ sent: true, method: "websocket" });
    } else {
      // Fall back to HTTP
      fetch(`${GATEWAY_HTTP_URL}/health`)
        .then((r) => {
          if (!r.ok) throw new Error("Gateway not available");
          // Use the HTTP scan endpoint via Tauri command
          // For now, do a simple check
          sendResponse({ sent: false, error: "Gateway not connected" });
        })
        .catch(() => {
          sendResponse({ sent: false, error: "Gateway not available" });
        });
      return true; // async response
    }
    return false;
  }

  if (message.type === "check_connection") {
    sendResponse({
      connected: ws && ws.readyState === WebSocket.OPEN,
    });
    return false;
  }

  if (message.type === "ping") {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
    sendResponse({ ok: true });
    return false;
  }
});

// Connect on startup
connect();
