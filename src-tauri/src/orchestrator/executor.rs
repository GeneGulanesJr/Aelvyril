//! Pi RPC executor — spawns `pi --mode rpc` as a subprocess and manages
//! the JSON-RPC communication for executing coding subtasks.

use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::time::timeout;

use super::contracts::is_safe_relative_path;
use super::errors::OrchestratorError;
use super::types::{ExecutionResult, ExecutorContext, OrchestratorSettings, Subtask};

/// Validate and filter `allowed_files` entries before passing to pi.
///
/// Rejects:
/// - Absolute paths (starting with `/` or drive letters like `C:\`)
/// - Path traversal components (`..`)
///
/// Returns the sanitized list. Logs warnings for dropped entries.
fn sanitize_allowed_files(allowed: &[String]) -> Vec<String> {
    let mut sanitized = Vec::with_capacity(allowed.len());
    for entry in allowed {
        if !is_safe_relative_path(entry) {
            tracing::warn!(
                "allowed_files: rejecting unsafe path '{}'",
                entry
            );
            continue;
        }
        sanitized.push(entry.trim().to_string());
    }
    sanitized
}

/// Check whether a touched file falls within the allowed_files scope.
///
/// - If the allowed entry ends with `/`, treat it as a directory prefix
///   (e.g. `src/` matches `src/foo.rs` and `src/bar/baz.rs`)
/// - Otherwise, match exact file path or as a directory prefix with `/` separator
///   (e.g. `src/lib.rs` matches `src/lib.rs` exactly,
///    `src` matches `src/foo.rs` via `src/` prefix)
fn is_file_in_scope(file: &str, allowed_files: &[String]) -> bool {
    for allowed in allowed_files {
        if allowed.ends_with('/') {
            if file.starts_with(allowed.as_str()) {
                return true;
            }
        } else {
            // Exact match
            if file == allowed.as_str() {
                return true;
            }
            // Directory prefix: the allowed path acts as a directory
            let prefix = format!("{}/", allowed);
            if file.starts_with(&prefix) {
                return true;
            }
        }
    }
    false
}

/// Monotonic command ID counter for correlating RPC requests/responses.
static COMMAND_ID: AtomicU64 = AtomicU64::new(1);

fn next_command_id() -> String {
    format!("orch-{}", COMMAND_ID.fetch_add(1, Ordering::Relaxed))
}

/// Write a JSON command to pi's stdin, LF-delimited.
async fn write_rpc_command(
    stdin: &mut tokio::process::ChildStdin,
    cmd: &serde_json::Value,
) -> Result<(), OrchestratorError> {
    let mut line = serde_json::to_string(cmd)?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(OrchestratorError::Io)?;
    stdin.flush().await.map_err(OrchestratorError::Io)?;
    Ok(())
}

/// Send a graceful abort command to pi.
async fn send_abort(child: &mut Child) -> Result<(), OrchestratorError> {
    let abort_cmd = serde_json::json!({
        "id": next_command_id(),
        "type": "abort"
    });
    if let Some(ref mut stdin) = child.stdin {
        let _ = write_rpc_command(stdin, &abort_cmd).await;
    }
    Ok(())
}

/// Extract a file path from a tool_execution_end event.
///
/// Looks for common file-modifying tools: write, edit, create, modify.
fn extract_file_from_tool_event(event: &serde_json::Value) -> Option<String> {
    let tool_name = event.get("tool").and_then(|t| t.as_str()).unwrap_or("");
    match tool_name {
        "write" | "edit" | "create" | "modify" | "patch" => {
            // Try various common field names
            event.get("filePath")
                .or_else(|| event.get("file"))
                .or_else(|| event.get("path"))
                .or_else(|| event.get("filename"))
                .or_else(|| event.get("args").and_then(|a| a.get("file")))
                .or_else(|| event.get("args").and_then(|a| a.get("path")))
                .or_else(|| event.get("args").and_then(|a| a.get("filePath")))
                .or_else(|| event.get("args").and_then(|a| a.get("filename")))
                .and_then(|f| f.as_str())
                .map(|s| s.to_string())
        }
        // Bash can also modify files, but we can't reliably extract paths
        "bash" | "shell" | "exec" => None,
        _ => None,
    }
}

/// Extract the summary text from pi's agent_end messages.
fn extract_summary_from_messages(messages: &serde_json::Value) -> String {
    if let Some(arr) = messages.as_array() {
        // Get the last assistant message
        for msg in arr.iter().rev() {
            if msg.get("role").and_then(|r| r.as_str()) == Some("assistant") {
                if let Some(content) = msg.get("content").and_then(|c| c.as_str()) {
                    return content.to_string();
                }
            }
        }
        // Fallback: concatenate all text content
        let texts: Vec<String> = arr
            .iter()
            .filter_map(|m| m.get("content").and_then(|c| c.as_str()))
            .map(|s| s.to_string())
            .collect();
        if !texts.is_empty() {
            return texts.join("\n");
        }
    }
    String::new()
}

/// Run `git diff --name-only` to detect file changes made by bash/shell commands
/// that aren't visible through tool_execution_end events.
///
/// Returns `Ok(Some(vec_of_paths))` if git is available and the directory is a git repo,
/// `Ok(None)` if not a git repo or git not available (graceful skip),
/// `Err` only for unexpected failures that should be logged.
async fn run_git_diff_audit(repo_path: &str) -> Option<Vec<String>> {
    let output = Command::new("git")
        .args(["diff", "--name-only"])
        .current_dir(repo_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await;

    match output {
        Ok(out) if out.status.success() => {
            let changed: Vec<String> = String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if !changed.is_empty() {
                tracing::info!(
                    "git diff audit found {} additional changed file(s): {:?}",
                    changed.len(),
                    changed
                );
            }
            Some(changed)
        }
        Ok(out) => {
            // Non-zero exit: likely not a git repo or git error
            let stderr = String::from_utf8_lossy(&out.stderr);
            tracing::debug!(
                "git diff audit skipped (exit code {}): {}",
                out.status,
                stderr.trim()
            );
            None
        }
        Err(e) => {
            tracing::debug!("git diff audit skipped (git not available): {}", e);
            None
        }
    }
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Result from spawning and monitoring the pi executor.
pub struct PiSpawnResult {
    pub completed: bool,
    pub files_touched: Vec<String>,
    pub tool_calls: u32,
    pub summary: String,
    pub stderr: String,
    /// Files touched outside the subtask's `allowed_files` scope.
    /// Computed once inside `spawn_pi_executor` so timeout/crash paths
    /// can also surface scope violations (previously lost on those paths).
    pub scope_violations: Vec<String>,
    pub error: Option<OrchestratorError>,
    /// Whether a git diff audit was performed to capture bash-made file changes.
    pub git_diff_applied: bool,
}

/// Spawn pi and execute a subtask via RPC.
///
/// This is the core executor integration:
/// 1. Spawns `pi --mode rpc` with the gateway provider
/// 2. Sends the subtask as a prompt (with `id` field)
/// 3. Monitors tool_execution events to track files touched
/// 4. Handles timeout, tool call limits, and graceful abort/kill
pub async fn spawn_pi_executor(
    subtask: &Subtask,
    context: &ExecutorContext,
    config: &OrchestratorSettings,
    gateway_key: &str,
    repo_path: Option<&str>,
    cancel_rx: &tokio::sync::watch::Receiver<bool>,
) -> Result<PiSpawnResult, OrchestratorError> {
    // Sanitize allowed_files: reject absolute paths and path traversal entries
    let sanitized_allowed = sanitize_allowed_files(&subtask.allowed_files);
    let sanitized_subtask = if sanitized_allowed.len() != subtask.allowed_files.len() {
        let mut st = subtask.clone();
        st.allowed_files = sanitized_allowed.clone();
        st
    } else {
        subtask.clone()
    };
    let allowed_for_scope = &sanitized_subtask.allowed_files;

    let prompt = super::context::build_executor_prompt(&sanitized_subtask, context);

    // Spawn pi in RPC mode
    let mut child = Command::new("pi")
        .args([
            "--mode", "rpc",
            "--provider", "aelvyril",
            "--model", &config.executor_model,
            "--api-key", gateway_key,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                OrchestratorError::PiNotInstalled
            } else {
                OrchestratorError::Io(e)
            }
        })?;

    // Send the prompt command with required id field
    let cmd_id = next_command_id();
    let prompt_cmd = serde_json::json!({
        "id": cmd_id,
        "type": "prompt",
        "message": prompt
    });

    {
        let stdin = child.stdin.as_mut().ok_or_else(|| {
            OrchestratorError::ExecutorCrashed("Failed to open pi stdin".into())
        })?;
        write_rpc_command(stdin, &prompt_cmd).await?;
    }

    // Read events with timeout and tool call limit
    let mut files_touched = Vec::new();
    let mut tool_calls: u32 = 0;
    let mut pi_summary = String::new();
    let mut completed = false;
    let mut stderr_buf = String::new();

    let timeout_dur = Duration::from_secs(config.executor_timeout_secs);

    // Take ownership of stdout for the reader
    let stdout = child.stdout.take().ok_or_else(|| {
        OrchestratorError::ExecutorCrashed("Failed to capture pi stdout".into())
    })?;

    let result = timeout(timeout_dur, async {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();

        loop {
            // Race between reading a line from pi and receiving a cancel signal.
            // When cancelled, send a graceful abort then kill the subprocess.
            let read_fut = reader.read_line(&mut line);
            let mut cancel_rx_inner = cancel_rx.clone();
            let cancel_fut = cancel_rx_inner.changed();

            tokio::select! {
                read_result = read_fut => {
                    match read_result {
                        Ok(0) => break, // EOF
                        Ok(_) => {}
                        Err(e) => {
                            return Err(OrchestratorError::Io(e));
                        }
                    }
                }
                changed_result = cancel_fut => {
                    if changed_result.is_ok() && *cancel_rx.borrow() {
                        tracing::info!("Cancellation received, killing pi subprocess");
                        if let Err(e) = send_abort(&mut child).await {
                            tracing::warn!("Failed to send abort command: {e}");
                        }
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        if let Err(e) = child.start_kill() {
                            tracing::warn!("Failed to kill pi subprocess: {e}");
                        }
                        if let Err(e) = child.wait().await {
                            tracing::debug!("Failed to wait for killed pi subprocess: {e}");
                        }
                        return Err(OrchestratorError::ExecutorCrashed(
                            "Cancelled by user".into(),
                        ));
                    }
                }
            }

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let event: serde_json::Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(_) => {
                    // Skip non-JSON lines (pi may emit debug output)
                    tracing::debug!("pi non-JSON output: {}", trimmed);
                    continue;
                }
            };

            match event.get("type").and_then(|t| t.as_str()) {
                Some("tool_execution_end") => {
                    tracing::trace!("pi tool_execution_end event: {}", trimmed);
                    tool_calls += 1;
                    if tool_calls > config.max_tool_calls {
                        tracing::warn!(
                            "pi exceeded tool call limit ({}/{}), aborting",
                            tool_calls,
                            config.max_tool_calls
                        );
                        if let Err(e) = send_abort(&mut child).await {
                            tracing::warn!("Failed to send abort on tool limit: {e}");
                        }
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        if let Err(e) = child.start_kill() {
                            tracing::warn!("Failed to kill pi after tool limit: {e}");
                        }
                        return Err(OrchestratorError::ToolCallLimit(tool_calls));
                    }
                    if let Some(file) = extract_file_from_tool_event(&event) {
                        if !files_touched.contains(&file) {
                            files_touched.push(file);
                        }
                    }
                }
                Some("agent_end") => {
                    completed = true;
                    if let Some(messages) = event.get("messages") {
                        pi_summary = extract_summary_from_messages(messages);
                    }
                    // Also check for a summary field directly
                    if pi_summary.is_empty() {
                        if let Some(s) = event.get("summary").and_then(|s| s.as_str()) {
                            pi_summary = s.to_string();
                        }
                    }
                    break;
                }
                Some("agent_start") => {
                    tracing::debug!("pi agent started processing");
                }
                Some("turn_end") => {
                    tracing::debug!("pi turn completed");
                }
                Some("message_update") => {
                    // v2: could forward these to UI for live progress
                }
                Some(other) => {
                    tracing::trace!("pi event: {}", other);
                }
                None => {
                    tracing::trace!("pi event without type: {}", trimmed);
                }
            }
        }

        Ok(())
    })
    .await;

    // Read stderr after process completes (non-blocking)
    if let Some(stderr) = child.stderr.take() {
        let mut stderr_reader = BufReader::new(stderr);
        let _ = tokio::io::AsyncReadExt::read_to_string(&mut stderr_reader, &mut stderr_buf).await;
        if !stderr_buf.is_empty() {
            tracing::debug!("pi stderr: {}", stderr_buf);
        }
    }

    match result {
        Ok(Ok(())) => {
            // Process completed normally
            // Ensure child is reaped
            let _ = child.wait().await;

            // Run git diff audit to capture bash-made file changes
            // that aren't visible through tool_execution_end events.
            let mut git_diff_applied = false;
            if let Some(repo) = repo_path {
                if let Some(changed) = run_git_diff_audit(repo).await {
                    git_diff_applied = true;
                    for file in changed {
                        if !files_touched.contains(&file) {
                            tracing::info!("git diff audit: adding bash-modified file '{}'", file);
                            files_touched.push(file);
                        }
                    }
                }
            }

            // Check scope violations using sanitized allowed_files.
            // Empty allowed_files means "no restrictions" (e.g. direct-mode tasks),
            // so skip the scope check entirely. Only flag violations when the
            // subtask explicitly specifies allowed files.
            let outside_scope: Vec<String> = if allowed_for_scope.is_empty() {
                Vec::new()
            } else {
                files_touched
                    .iter()
                    .filter(|f| !is_file_in_scope(f, allowed_for_scope))
                    .cloned()
                    .collect()
            };

            Ok(PiSpawnResult {
                completed,
                files_touched,
                tool_calls,
                summary: pi_summary,
                stderr: stderr_buf,
                scope_violations: if !outside_scope.is_empty() {
                    outside_scope
                } else {
                    Vec::new()
                },
                error: if !completed && tool_calls == 0 {
                    Some(OrchestratorError::EmptyExecution)
                } else {
                    None
                },
                git_diff_applied,
            })
        }
        Ok(Err(e)) => {
            // Internal error from event processing
            if let Err(kill_err) = child.start_kill() {
                tracing::warn!("Failed to kill pi after internal error: {kill_err}");
            }
            if let Err(wait_err) = child.wait().await {
                tracing::debug!("Failed to wait for killed pi: {wait_err}");
            }
            Err(e)
        }
        Err(_elapsed) => {
            // Timeout
            tracing::warn!("pi executor timed out after {}s", config.executor_timeout_secs);
            if let Err(e) = send_abort(&mut child).await {
                tracing::warn!("Failed to send abort on timeout: {e}");
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
            if let Err(e) = child.start_kill() {
                tracing::warn!("Failed to kill pi after timeout: {e}");
            }
            if let Err(e) = child.wait().await {
                tracing::debug!("Failed to wait for killed pi after timeout: {e}");
            }
            Err(OrchestratorError::ExecutorTimeout(config.executor_timeout_secs))
        }
    }
}

/// Build an `ExecutionResult` from the spawn result.
///
/// Uses the scope violations already computed inside `spawn_pi_executor`
/// (so they survive even on timeout/crash paths) instead of re-deriving
/// them from `allowed_files` here.
pub fn build_execution_result(subtask_id: &str, spawn_result: PiSpawnResult) -> ExecutionResult {
    let needs_replan = !spawn_result.scope_violations.is_empty();

    ExecutionResult {
        subtask_id: subtask_id.to_string(),
        pi_completed: spawn_result.completed,
        files_touched: spawn_result.files_touched,
        files_outside_scope: spawn_result.scope_violations.clone(),
        pi_summary: spawn_result.summary,
        tool_calls_made: spawn_result.tool_calls,
        turns_taken: 0,
        needs_replan,
        replan_reason: if needs_replan {
            Some(format!(
                "Executor touched files outside allowed scope: {}",
                spawn_result.scope_violations.join(", ")
            ))
        } else {
            None
        },
        git_diff_applied: spawn_result.git_diff_applied,
    }
}

// ── Pre-flight: pi checks ────────────────────────────────────────────────────

/// Check if pi is installed (on PATH).
pub async fn check_pi_installed() -> Result<String, OrchestratorError> {
    let output = Command::new("which")
        .arg("pi")
        .output()
        .await
        .map_err(OrchestratorError::Io)?;

    if !output.status.success() {
        return Err(OrchestratorError::PiNotInstalled);
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(path)
}

/// Check if pi has an "aelvyril" provider configured in models.json.
/// Returns the current models.json content.
pub async fn check_pi_models_config() -> Result<serde_json::Value, OrchestratorError> {
    let home = std::env::var("HOME").map_err(|_| {
        OrchestratorError::PiConfigError("Cannot determine HOME directory".into())
    })?;
    let models_path = std::path::Path::new(&home)
        .join(".pi")
        .join("agent")
        .join("models.json");

    if !models_path.exists() {
        return Err(OrchestratorError::PiConfigError(
            "models.json not found at ~/.pi/agent/models.json".into(),
        ));
    }

    let content = tokio::fs::read_to_string(&models_path)
        .await
        .map_err(|e| {
            OrchestratorError::PiConfigError(format!("Cannot read models.json: {e}"))
        })?;

    serde_json::from_str(&content).map_err(|e| {
        OrchestratorError::PiConfigError(format!("Invalid JSON in models.json: {e}"))
    })
}

/// Ensure pi has an "aelvyril" provider entry in models.json.
///
/// If missing or stale (wrong port/key), writes/updates the entry.
/// Merges with existing providers — does NOT overwrite the entire file.
pub async fn ensure_pi_aelvyril_provider(
    gateway_port: u16,
    gateway_key: &str,
    executor_model: &str,
    planning_model: &str,
) -> Result<(), OrchestratorError> {
    let home = std::env::var("HOME").map_err(|_| {
        OrchestratorError::PiConfigError("Cannot determine HOME directory".into())
    })?;
    let pi_dir = std::path::Path::new(&home).join(".pi").join("agent");
    let models_path = pi_dir.join("models.json");

    // Ensure directory exists
    tokio::fs::create_dir_all(&pi_dir).await.map_err(|e| {
        OrchestratorError::PiConfigError(format!("Cannot create ~/.pi/agent/: {e}"))
    })?;

    // Read existing config or create empty
    let mut config: serde_json::Value = if models_path.exists() {
        let content = tokio::fs::read_to_string(&models_path)
            .await
            .map_err(|e| {
                OrchestratorError::PiConfigError(format!("Cannot read models.json: {e}"))
            })?;
        serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // Build the aelvyril provider entry
    let mut models_arr = vec![serde_json::json!({ "id": executor_model })];
    if planning_model != executor_model {
        models_arr.push(serde_json::json!({ "id": planning_model }));
    }

    let aelvyril_provider = serde_json::json!({
        "baseUrl": format!("http://localhost:{}/v1", gateway_port),
        "api": "openai-completions",
        "apiKey": gateway_key,
        "models": models_arr
    });

    // Merge into providers
    if !config.get("providers").is_some() {
        config["providers"] = serde_json::json!({});
    }
    let providers = config["providers"].as_object_mut().ok_or_else(|| {
        OrchestratorError::PiConfigError("'providers' is not an object in models.json".into())
    })?;

    // Check if we need to update
    let needs_update = match providers.get("aelvyril") {
        Some(existing) => {
            let existing_url = existing.get("baseUrl").and_then(|u| u.as_str()).unwrap_or("");
            let expected_url = format!("http://localhost:{}/v1", gateway_port);
            let existing_key = existing.get("apiKey").and_then(|k| k.as_str()).unwrap_or("");
            existing_url != expected_url || existing_key != gateway_key
        }
        None => true,
    };

    if needs_update {
        providers.insert("aelvyril".to_string(), aelvyril_provider);

        // Write back
        let json_str = serde_json::to_string_pretty(&config).map_err(|e| {
            OrchestratorError::PiConfigError(format!("Cannot serialize models.json: {e}"))
        })?;

        tokio::fs::write(&models_path, json_str).await.map_err(|e| {
            OrchestratorError::PiConfigError(format!("Cannot write models.json: {e}"))
        })?;

        tracing::info!(
            "Wrote aelvyril provider to pi models.json (port={}, models=[{}, {}])",
            gateway_port,
            executor_model,
            planning_model
        );
    }

    Ok(())
}
