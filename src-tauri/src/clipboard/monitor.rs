use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::broadcast;
use tokio::time;

use crate::clipboard::{ClipboardAction, ClipboardEvent, ClipboardResponse};
use crate::pii::PiiEngine;

/// The clipboard monitor tracks clipboard changes and scans for PII.
pub struct ClipboardMonitor {
    /// Last clipboard content hash to detect changes
    last_hash: Arc<Mutex<u64>>,
    /// Pending events awaiting user action
    pending: Arc<Mutex<Option<ClipboardEvent>>>,
    /// Broadcast channel for clipboard events → frontend + notifications
    event_tx: broadcast::Sender<ClipboardEvent>,
    /// PII engine for scanning
    pii_engine: Arc<Mutex<PiiEngine>>,
    /// Whether monitoring is active
    active: Arc<Mutex<bool>>,
}

impl ClipboardMonitor {
    pub fn new(pii_engine: PiiEngine) -> Self {
        let (event_tx, _) = broadcast::channel(64);
        Self {
            last_hash: Arc::new(Mutex::new(0)),
            pending: Arc::new(Mutex::new(None)),
            event_tx,
            pii_engine: Arc::new(Mutex::new(pii_engine)),
            active: Arc::new(Mutex::new(false)),
        }
    }

    /// Subscribe to clipboard events
    pub fn subscribe(&self) -> broadcast::Receiver<ClipboardEvent> {
        self.event_tx.subscribe()
    }

    /// Start monitoring the clipboard
    pub fn start(&self) {
        *self.active.lock() = true;
    }

    /// Stop monitoring the clipboard
    pub fn stop(&self) {
        *self.active.lock() = false;
    }

    pub fn is_active(&self) -> bool {
        *self.active.lock()
    }

    /// Scan clipboard content for PII. Called by the polling loop or
    /// platform-specific callback.
    pub fn scan_content(&self, content: &str) -> Option<ClipboardEvent> {
        if !*self.active.lock() {
            return None;
        }

        // Simple hash to detect changes
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        content.hash(&mut hasher);
        let hash = hasher.finish();

        {
            let last = self.last_hash.lock();
            if hash == *last {
                return None; // No change
            }
        }

        *self.last_hash.lock() = hash;

        // Scan for PII
        let engine = self.pii_engine.lock();
        let matches = engine.detect_sync(content);
        drop(engine);

        let detected_entities: Vec<(String, usize)> = {
            let mut summary = std::collections::HashMap::new();
            for m in &matches {
                *summary.entry(m.pii_type.to_string()).or_insert(0usize) += 1;
            }
            summary.into_iter().collect()
        };

        let action = if matches.is_empty() {
            ClipboardAction::Clean
        } else {
            ClipboardAction::Pending
        };

        let event = ClipboardEvent {
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            content_length: content.len(),
            detected_entities: detected_entities.clone(),
            action_taken: action,
        };

        // Only broadcast if there's something interesting
        if !matches.is_empty() {
            // Store as pending for user action
            *self.pending.lock() = Some(event.clone());

            if let Err(e) = self.event_tx.send(event.clone()) {
                tracing::warn!("Failed to broadcast clipboard PII event: {}", e);
            }
            Some(event)
        } else {
            None
        }
    }

    /// User responded to a clipboard notification
    pub fn respond(&self, response: ClipboardResponse) -> Option<ClipboardEvent> {
        let mut pending = self.pending.lock();
        let mut event = pending.take()?;

        event.action_taken = match response {
            ClipboardResponse::Sanitize => ClipboardAction::Sanitized,
            ClipboardResponse::Allow => ClipboardAction::Allowed,
            ClipboardResponse::Block => ClipboardAction::Blocked,
        };

        if let Err(e) = self.event_tx.send(event.clone()) {
            tracing::warn!("Failed to broadcast clipboard response event: {}", e);
        }
        Some(event)
    }

    /// Sanitize clipboard content by replacing PII with tokens
    pub fn sanitize_content(&self, content: &str) -> String {
        let engine = self.pii_engine.lock();
        let matches = engine.detect_sync(content);
        drop(engine);

        if matches.is_empty() {
            return content.to_string();
        }

        let mut pseudonymizer = crate::pseudonym::Pseudonymizer::new();
        let (sanitized, _) = pseudonymizer.pseudonymize(content, &matches);
        sanitized
    }
}

/// Run the clipboard polling loop. Uses a cross-platform approach:
/// - Reads the system clipboard on an interval
/// - On clipboard change, scans for PII
pub async fn run_clipboard_poll(monitor: Arc<ClipboardMonitor>) {
    // 1 second default — fast enough for UX, gentle on process spawn overhead.
    let mut interval = time::interval(Duration::from_secs(1));
    let mut last_content: Option<String> = None;
    let mut consecutive_errors: u32 = 0;

    loop {
        interval.tick().await;

        if !monitor.is_active() {
            consecutive_errors = 0;
            continue;
        }

        // Read clipboard content
        match read_clipboard() {
            Ok(content) => {
                consecutive_errors = 0;
                // Only process if content changed
                if last_content.as_ref() != Some(&content) {
                    last_content = Some(content.clone());
                    monitor.scan_content(&content);
                }
            }
            Err(e) => {
                consecutive_errors = consecutive_errors.saturating_add(1);
                // Log the first few errors so the user knows something is wrong,
                // then suppress to avoid log spam.
                if consecutive_errors <= 3 {
                    tracing::warn!("Clipboard read failed: {}", e);
                }
                // Back off exponentially after repeated failures (max ~32s)
                if consecutive_errors > 5 {
                    interval = time::interval(Duration::from_secs(1 << consecutive_errors.min(5)));
                }
            }
        }
    }
}

/// Read the current system clipboard content.
/// Uses platform-specific mechanisms where possible.
fn read_clipboard() -> Result<String, String> {
    // We use a simple approach: try arboard, fall back to cli tools
    #[cfg(target_os = "macos")]
    {
        read_clipboard_macos()
    }

    #[cfg(target_os = "windows")]
    {
        read_clipboard_windows()
    }

    #[cfg(target_os = "linux")]
    {
        read_clipboard_linux()
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("Clipboard not supported on this platform".into())
    }
}

#[cfg(target_os = "macos")]
fn read_clipboard_macos() -> Result<String, String> {
    // Use pbpaste for macOS
    let output = std::process::Command::new("pbpaste")
        .output()
        .map_err(|e| format!("pbpaste failed: {}", e))?;
    String::from_utf8(output.stdout).map_err(|e| format!("Invalid UTF-8: {}", e))
}

#[cfg(target_os = "windows")]
fn read_clipboard_windows() -> Result<String, String> {
    // Use PowerShell clipboard
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", "Get-Clipboard"])
        .output()
        .map_err(|e| format!("PowerShell clipboard failed: {}", e))?;
    String::from_utf8(output.stdout).map_err(|e| format!("Invalid UTF-8: {}", e))
}

#[cfg(target_os = "linux")]
fn read_clipboard_linux() -> Result<String, String> {
    // Detect the best available clipboard tool once and cache the result
    // so we don't spawn a missing binary on every poll.
    use std::sync::OnceLock;

    #[derive(Clone, Copy)]
    enum LinuxClipboardTool {
        Xclip,
        WlPaste,
        Xsel,
    }

    static DETECTED_TOOL: OnceLock<Option<LinuxClipboardTool>> = OnceLock::new();

    let tool = DETECTED_TOOL.get_or_init(|| {
        // Check for xclip (X11)
        if std::process::Command::new("xclip")
            .args(["-selection", "clipboard", "-o", "-t", "TIMESTAMP"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            tracing::info!("Clipboard tool detected: xclip (X11)");
            return Some(LinuxClipboardTool::Xclip);
        }

        // Check for wl-paste (Wayland)
        if std::process::Command::new("wl-paste")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            tracing::info!("Clipboard tool detected: wl-paste (Wayland)");
            return Some(LinuxClipboardTool::WlPaste);
        }

        // Check for xsel (X11 fallback)
        if std::process::Command::new("xsel")
            .args(["--clipboard", "--output"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            tracing::info!("Clipboard tool detected: xsel (X11 fallback)");
            return Some(LinuxClipboardTool::Xsel);
        }

        tracing::warn!(
            "No clipboard tool found. Install xclip (X11), wl-paste (Wayland), or xsel."
        );
        None
    });

    let output = match *tool {
        Some(LinuxClipboardTool::Xclip) => std::process::Command::new("xclip")
            .args(["-selection", "clipboard", "-o"])
            .output()
            .map_err(|e| format!("xclip failed: {}", e))?,
        Some(LinuxClipboardTool::WlPaste) => std::process::Command::new("wl-paste")
            .arg("--no-newline")
            .output()
            .map_err(|e| format!("wl-paste failed: {}", e))?,
        Some(LinuxClipboardTool::Xsel) => std::process::Command::new("xsel")
            .args(["--clipboard", "--output"])
            .output()
            .map_err(|e| format!("xsel failed: {}", e))?,
        None => {
            return Err("No clipboard tool available. Install xclip, wl-paste, or xsel.".into());
        }
    };

    if output.status.success() {
        String::from_utf8(output.stdout).map_err(|e| format!("Invalid UTF-8 from clipboard: {}", e))
    } else {
        Err(format!(
            "Clipboard tool exited with error: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}
