use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::broadcast;
use tokio::time;

use crate::clipboard::{ClipboardAction, ClipboardEvent, ClipboardResponse};
use crate::pii::PiiEngine;

/// Broadcast channel capacity for clipboard events
const CLIPBOARD_EVENT_CHANNEL_CAPACITY: usize = 64;

/// Number of consecutive clipboard errors to log before suppressing
const CLIPBOARD_ERROR_LOG_THRESHOLD: u32 = 3;

/// Number of consecutive errors before exponential backoff kicks in
const CLIPBOARD_BACKOFF_ERROR_THRESHOLD: u32 = 5;

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
        let (event_tx, _) = broadcast::channel(CLIPBOARD_EVENT_CHANNEL_CAPACITY);
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

        // Only broadcast if there's something interesting
        if matches.is_empty() {
            return None;
        }

        let event = ClipboardEvent {
            id: uuid::Uuid::new_v4().to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            content_length: content.len(),
            detected_entities,
            action_taken: action,
        };

        // Store as pending for user action (moved, not cloned)
        *self.pending.lock() = Some(event.clone());

        if let Err(e) = self.event_tx.send(event.clone()) {
            tracing::warn!("Failed to broadcast clipboard PII event: {}", e);
        }
        Some(event)
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

        // Clone only when needed for broadcasting
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
    let mut interval = time::interval(Duration::from_secs(1));
    let mut last_content: Option<String> = None;
    let mut consecutive_errors: u32 = 0;
    let mut consecutive_idle_ticks: u32 = 0;
    let mut current_interval_secs: u64 = 1;

    loop {
        interval.tick().await;

        if !monitor.is_active() {
            consecutive_errors = 0;
            consecutive_idle_ticks = 0;
            current_interval_secs = 1;
            interval = time::interval(Duration::from_secs(current_interval_secs));
            continue;
        }

        match read_clipboard() {
            Ok(content) => {
                consecutive_errors = 0;

                let changed = last_content.as_ref() != Some(&content);
                if changed {
                    last_content = Some(content.clone());
                    consecutive_idle_ticks = 0;

                    // Speed up after a change (user might be copying rapidly)
                    if current_interval_secs > 1 {
                        current_interval_secs = 1;
                        interval = time::interval(Duration::from_secs(current_interval_secs));
                    }

                    monitor.scan_content(&content);
                } else {
                    consecutive_idle_ticks += 1;

                    // Gradually slow down when idle: 1s → 2s → 4s → 8s → 15s → 30s
                    let new_interval = if consecutive_idle_ticks > 300 {
                        30 // 5 minutes idle → 30s polling
                    } else if consecutive_idle_ticks > 120 {
                        15 // 2 minutes idle
                    } else if consecutive_idle_ticks > 60 {
                        8 // 1 minute idle
                    } else if consecutive_idle_ticks > 20 {
                        4 // 20 seconds idle
                    } else if consecutive_idle_ticks > 5 {
                        2 // 5 seconds idle
                    } else {
                        1 // Active polling
                    };

                    if new_interval != current_interval_secs {
                        current_interval_secs = new_interval;
                        interval = time::interval(Duration::from_secs(current_interval_secs));
                        tracing::debug!(
                            "Clipboard poll interval adjusted to {}s ({} idle ticks)",
                            current_interval_secs,
                            consecutive_idle_ticks
                        );
                    }
                }
            }
            Err(e) => {
                consecutive_errors = consecutive_errors.saturating_add(1);
                if consecutive_errors <= CLIPBOARD_ERROR_LOG_THRESHOLD {
                    tracing::warn!("Clipboard read failed: {}", e);
                }
                if consecutive_errors > CLIPBOARD_BACKOFF_ERROR_THRESHOLD {
                    interval = time::interval(Duration::from_secs(
                        1 << consecutive_errors.min(CLIPBOARD_BACKOFF_ERROR_THRESHOLD),
                    ));
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
#[derive(Clone, Copy, Debug)]
enum LinuxClipboardTool {
    Xclip,
    WlPaste,
    Xsel,
}

#[cfg(target_os = "linux")]
fn command_succeeds(cmd: &str, args: &[&str]) -> bool {
    std::process::Command::new(cmd)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn detect_linux_clipboard_tool() -> Option<LinuxClipboardTool> {
    let detectors: &[(LinuxClipboardTool, &str, &[&str])] = &[
        (
            LinuxClipboardTool::Xclip,
            "xclip",
            &["-selection", "clipboard", "-o", "-t", "TIMESTAMP"],
        ),
        (LinuxClipboardTool::WlPaste, "wl-paste", &["--version"]),
        (
            LinuxClipboardTool::Xsel,
            "xsel",
            &["--clipboard", "--output"],
        ),
    ];

    for (tool, cmd, args) in detectors {
        if command_succeeds(cmd, args) {
            match tool {
                LinuxClipboardTool::Xclip => {
                    tracing::info!("Clipboard tool detected: xclip (X11)");
                }
                LinuxClipboardTool::WlPaste => {
                    tracing::info!("Clipboard tool detected: wl-paste (Wayland)");
                }
                LinuxClipboardTool::Xsel => {
                    tracing::info!("Clipboard tool detected: xsel (X11 fallback)");
                }
            }
            return Some(*tool);
        }
    }

    tracing::warn!("No clipboard tool found. Install xclip (X11), wl-paste (Wayland), or xsel.");
    None
}

#[cfg(target_os = "linux")]
fn run_linux_clipboard_tool(tool: LinuxClipboardTool) -> Result<std::process::Output, String> {
    match tool {
        LinuxClipboardTool::Xclip => std::process::Command::new("xclip")
            .args(["-selection", "clipboard", "-o"])
            .output()
            .map_err(|e| format!("xclip failed: {}", e)),
        LinuxClipboardTool::WlPaste => std::process::Command::new("wl-paste")
            .arg("--no-newline")
            .output()
            .map_err(|e| format!("wl-paste failed: {}", e)),
        LinuxClipboardTool::Xsel => std::process::Command::new("xsel")
            .args(["--clipboard", "--output"])
            .output()
            .map_err(|e| format!("xsel failed: {}", e)),
    }
}

#[cfg(target_os = "linux")]
fn decode_clipboard_output(output: std::process::Output) -> Result<String, String> {
    if output.status.success() {
        String::from_utf8(output.stdout)
            .map_err(|e| format!("Invalid UTF-8 from clipboard: {}", e))
    } else {
        Err(format!(
            "Clipboard tool exited with error: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

#[cfg(target_os = "linux")]
fn read_clipboard_linux() -> Result<String, String> {
    // Detect the best available clipboard tool once and cache the result
    // so we don't spawn a missing binary on every poll.
    use std::sync::OnceLock;

    static DETECTED_TOOL: OnceLock<Option<LinuxClipboardTool>> = OnceLock::new();

    let tool = DETECTED_TOOL
        .get_or_init(detect_linux_clipboard_tool)
        .ok_or_else(|| "No clipboard tool available. Install xclip, wl-paste, or xsel.".to_string())?;

    let output = run_linux_clipboard_tool(tool)?;
    decode_clipboard_output(output)
}
