/**
 * Aelvyril Browser Extension — Popup Script
 */

const dot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const gatewayStatus = document.getElementById("gateway-status");

function checkConnection() {
  chrome.runtime.sendMessage({ type: "check_connection" }, (response) => {
    if (chrome.runtime.lastError) {
      updateStatus(false);
      return;
    }
    updateStatus(response?.connected ?? false);
  });
}

function updateStatus(connected) {
  if (connected) {
    dot.className = "dot connected";
    statusText.textContent = "Connected";
    gatewayStatus.textContent = "Online — scanning active";
  } else {
    dot.className = "dot disconnected";
    statusText.textContent = "Disconnected";
    gatewayStatus.textContent = "Desktop app not detected";
  }
}

const POLL_INTERVAL_MS = 3000;
let pollIntervalId = null;

function startPolling() {
  if (pollIntervalId) return;
  checkConnection();
  pollIntervalId = setInterval(checkConnection, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
}

startPolling();

// Clean up when popup is closed
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    stopPolling();
  } else {
    startPolling();
  }
});
