/**
 * Aelvyril Browser Extension — Content Script
 *
 * Monitors clipboard paste events in web-based AI tools.
 * When a paste is detected, sends the content to the Aelvyril
 * desktop app for PII scanning. If sensitive content is found,
 * shows an inline warning banner.
 */

// ── Configuration ─────────────────────────────────────────────────────────

// Known AI tool hostnames where we actively scan
const AI_TOOL_HOSTNAMES = [
  "chat.openai.com",
  "chatgpt.com",
  "claude.ai",
  "gemini.google.com",
  "poe.com",
  "character.ai",
  "perplexity.ai",
  "you.com",
  "huggingface.co",
];

// ── State ──────────────────────────────────────────────────────────────────

let isAiTool = false;
let bannerElement = null;
let bannerAutoDismissTimer = null;
let pendingRequests = new Map();

// ── Init ───────────────────────────────────────────────────────────────────

function init() {
  isAiTool = AI_TOOL_HOSTNAMES.some(
    (host) => window.location.hostname === host || window.location.hostname.endsWith("." + host)
  );

  if (isAiTool) {
    console.log("[Aelvyril] Active on AI tool:", window.location.hostname);

    // Listen for paste events
    document.addEventListener("paste", handlePaste, true);

    // Listen for messages from background script
    chrome.runtime.onMessage.addListener(handleMessage);
  }
}

// ── Paste Handler ──────────────────────────────────────────────────────────

function handlePaste(event) {
  const clipboardData = event.clipboardData?.getData("text");
  if (!clipboardData || clipboardData.length < 5) return;

  const requestId = crypto.randomUUID();
  pendingRequests.set(requestId, { content: clipboardData });

  // Auto-cleanup if no response arrives within 15 seconds
  setTimeout(() => pendingRequests.delete(requestId), 15000);

  // Send to background for scanning
  chrome.runtime.sendMessage(
    { type: "scan", content: clipboardData, requestId },
    (response) => {
      if (response?.sent) {
        // Result will come asynchronously via handleMessage
      }
    }
  );
}

// ── Message Handler ────────────────────────────────────────────────────────

function handleMessage(message) {
  if (message.type === "scan_result") {
    const pending = pendingRequests.get(message.requestId);
    if (pending) {
      pendingRequests.delete(message.requestId);

      if (message.hasPii) {
        showWarningBanner(message.entities, message.sanitizedContent);
      } else {
        removeBanner();
      }
    }
  }

  if (message.type === "connection_status") {
    if (!message.connected) {
      removeBanner();
    }
  }
}

// ── Banner UI ──────────────────────────────────────────────────────────────

function showWarningBanner(entities, sanitizedContent) {
  removeBanner();

  const entityList = entities
    .map(([type, count]) => `${type} (${count})`)
    .join(", ");

  // Escape HTML to prevent XSS from entity names
  const escapedList = entityList
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  bannerElement = document.createElement("div");
  bannerElement.id = "aelvyril-banner";
  bannerElement.innerHTML = `
    <div class="aelvyril-banner-content">
      <div class="aelvyril-banner-icon">🛡️</div>
      <div class="aelvyril-banner-text">
        <strong>Aelvyril detected sensitive content:</strong>
        <span>${escapedList}</span>
      </div>
      <div class="aelvyril-banner-actions">
        ${sanitizedContent ? '<button class="aelvyril-btn aelvyril-btn-primary" data-action="sanitize">Sanitize</button>' : ''}
        <button class="aelvyril-btn aelvyril-btn-allow" data-action="allow">Allow</button>
        <button class="aelvyril-btn aelvyril-btn-block" data-action="block">Block</button>
        <button class="aelvyril-btn aelvyril-btn-close" data-action="dismiss">✕</button>
      </div>
    </div>
  `;

  // Button handlers
  bannerElement.addEventListener("click", (e) => {
    const action = e.target.dataset.action;
    if (action === "sanitize" && sanitizedContent) {
      // Replace clipboard content with sanitized version
      navigator.clipboard.writeText(sanitizedContent);
      showNotification("Content sanitized and copied to clipboard.");
      removeBanner();
    } else if (action === "allow") {
      chrome.runtime.sendMessage({ type: "blocked", requestId: "allow" });
      removeBanner();
    } else if (action === "block") {
      chrome.runtime.sendMessage({ type: "blocked", requestId: "block" });
      removeBanner();
    } else if (action === "dismiss") {
      removeBanner();
    }
  });

  document.body.appendChild(bannerElement);

  // Auto-dismiss after 30 seconds
  if (bannerAutoDismissTimer) clearTimeout(bannerAutoDismissTimer);
  bannerAutoDismissTimer = setTimeout(() => removeBanner(), 30000);
}

const NOTIFICATION_DURATION_MS = 3000;
let notificationTimer = null;

function showNotification(text) {
  // Clear any existing notification timer
  if (notificationTimer) clearTimeout(notificationTimer);
  const existing = document.getElementById("aelvyril-notification");
  if (existing) existing.remove();

  const notif = document.createElement("div");
  notif.id = "aelvyril-notification";
  notif.textContent = text;
  document.body.appendChild(notif);
  notificationTimer = setTimeout(() => {
    notif.remove();
    notificationTimer = null;
  }, NOTIFICATION_DURATION_MS);
}

function removeBanner() {
  if (bannerAutoDismissTimer) {
    clearTimeout(bannerAutoDismissTimer);
    bannerAutoDismissTimer = null;
  }
  const existing = document.getElementById("aelvyril-banner");
  if (existing) existing.remove();
  bannerElement = null;
}

// ── Start ──────────────────────────────────────────────────────────────────

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
