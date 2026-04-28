use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::AsyncBufReadExt;
use tokio::process::{Child, Command};
use tokio::sync::RwLock;
use tracing;

static PORT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)server is listening on .*?:(\\d+)").unwrap()
});
const MAX_HEALTH_ATTEMPTS: usize = 30;
const HEALTH_POLL_INTERVAL_MS: u64 = 500;

/// Errors from the Llama server manager.
#[derive(Debug, Clone)]
pub enum LlamaError {
    /// The server is not running or was not started.
    NotRunning(String),
    /// The server process failed to start.
    StartFailed(String),
    /// An HTTP request to the server failed.
    RequestFailed(String),
    /// The model's output could not be parsed.
    ParseError(String),
    /// Building the chat prompt failed.
    PromptBuildFailed(String),
}

impl std::fmt::Display for LlamaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotRunning(msg) => write!(f, "Llama server not running: {msg}"),
            Self::StartFailed(msg) => write!(f, "Failed to start llama-server: {msg}"),
            Self::RequestFailed(msg) => write!(f, "Llama request failed: {msg}"),
            Self::ParseError(msg) => write!(f, "Failed to parse LLM response: {msg}"),
            Self::PromptBuildFailed(msg) => write!(f, "Failed to build chat prompt: {msg}"),
        }
    }
}

impl std::error::Error for LlamaError {}

/// Completion request to llama-server `/completion` endpoint.
#[derive(Debug, Serialize)]
struct CompletionRequest {
    prompt: String,
    n_predict: i32,
    temperature: f32,
    stop: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    n_keep: Option<i32>,
}

/// Completion response from llama-server `/completion` endpoint.
#[derive(Debug, Deserialize)]
struct CompletionResponse {
    content: String,
    #[allow(dead_code)]
    stop: String,
}

/// A managed `llama-server` child process.
///
/// Starts the llama.cpp HTTP server with a GGUF model on a random port,
/// waits for it to become healthy, and provides a client for completions.
pub struct LlamaServer {
    child: Option<Child>,
    port: u16,
    base_url: String,
    http: reqwest::Client,
}

impl LlamaServer {
    /// Start `llama-server` with the given GGUF model file.
    ///
    /// Searches for `llama-server` in `PATH`. The server is started on
    /// `127.0.0.1` on a fixed port (8082). Stderr/stdout are inherited so
    /// logs are visible but not parsed.
    ///
    /// Returns a wrapped `Arc<RwLock<Self>>` ready for shared use.
    pub async fn start(gguf_path: &str) -> Result<Arc<RwLock<Self>>, LlamaError> {
        let llama_server_bin = which_llama_server().ok_or_else(|| {
            LlamaError::StartFailed(
                "llama-server not found in PATH. Install llama.cpp or add to PATH.".to_string(),
            )
        })?;

        let port = 8082;
        let mut cmd = Command::new(&llama_server_bin);

        /* ── GPU backend auto-detection ────────────────────────────────
           llama-server ≥ b4600 discovers backends (libggml-*.so) via:
           1) the directory containing the llama-server binary
           2) LD_LIBRARY_PATH at runtime
           We add ~/.local/lib/llama.cpp/ so user-installed ROCm/Vulkan
           backends are discoverable without editing the system.
           ROCm RX 9070 XT ships as gfx1021 which needs HSA_OVERRIDE. */
        if let Ok(home) = std::env::var("HOME") {
            let lib_dir = std::path::Path::new(&home).join(".local/lib/llama.cpp");
            if lib_dir.is_dir() {
                let ld_path = match std::env::var("LD_LIBRARY_PATH") {
                    Ok(old) => format!("{}:{}", lib_dir.display(), old),
                    Err(_) => lib_dir.display().to_string(),
                };
                cmd.env("LD_LIBRARY_PATH", ld_path);
            }
        }
        // ROCm gfx1201 (RX 9070) → override to gfx1200 which ROCm 7.2 supports
        if std::env::var("HSA_OVERRIDE_GFX_VERSION").is_err() {
            cmd.env("HSA_OVERRIDE_GFX_VERSION", "12.0.0");
        }

        let mut child = cmd
            .args([
                "-m", gguf_path,
                "--port", "8082",
                "--host", "127.0.0.1",
                "-c", "2048",
                "-n", "1024",
                "--temp", "0.1",
                "--n-gpu-layers", "1000",
            ])
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .map_err(|e| LlamaError::StartFailed(format!("spawn failed: {e}")))?;

        let base_url = format!("http://127.0.0.1:{}", port);
        tracing::info!(%gguf_path, %base_url, "llama-server started");

        let server = Self {
            child: Some(child),
            port,
            base_url,
            http: reqwest::Client::new(),
        };

        // Wait for the server to become healthy
        for i in 0..MAX_HEALTH_ATTEMPTS {
            if server.health_check().await {
                tracing::info!("llama-server healthy after {} poll(s)", i + 1);
                return Ok(Arc::new(RwLock::new(server)));
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(HEALTH_POLL_INTERVAL_MS)).await;
        }
        Err(LlamaError::StartFailed(
            format!("server not healthy after {MAX_HEALTH_ATTEMPTS} attempts"),
        ))
    }

    /// Check if the server's `/health` endpoint returns 200.
    pub async fn health_check(&self) -> bool {
        let url = format!("{}/health", self.base_url);
        self.http
            .get(&url)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    /// The base URL the server is listening on (e.g. `http://127.0.0.1:12345`).
    pub fn base_url(&self) -> &str {
        &self.base_url
    }
    /// Send a completion prompt and return the raw text output.
    pub async fn complete(&self, prompt: &str) -> Result<String, LlamaError> {
        let url = format!("{}/completion", self.base_url);
        let req = CompletionRequest {
            prompt: prompt.to_string(),
            n_predict: 1024,
            temperature: 0.1,
            stop: vec!["
".to_string(), "\n\n".to_string()],
            n_keep: Some(0),
        };

        let resp = self
            .http
            .post(&url)
            .json(&req)
            .send()
            .await
            .map_err(|e| LlamaError::RequestFailed(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(LlamaError::RequestFailed(format!("{}: {}", status, body)));
        }

        let body: CompletionResponse = resp
            .json()
            .await
            .map_err(|e| LlamaError::RequestFailed(format!("parse response: {e}")))?;

        Ok(body.content)
    }


    /// Kill the server process.
    pub async fn shutdown(&mut self) {
        if let Some(ref mut child) = self.child {
            let _ = child.kill().await;
        }
        self.child = None;
        tracing::info!("llama-server stopped");
    }

    /// Wait for the server to become healthy (polls `/health`).
    async fn wait_for_ready(&self) -> Result<(), LlamaError> {
        for i in 0..MAX_HEALTH_ATTEMPTS {
            if self.health_check().await {
                tracing::info!("llama-server healthy after {} poll(s)", i + 1);
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(HEALTH_POLL_INTERVAL_MS)).await;
        }
        Err(LlamaError::StartFailed(format!(
            "server not healthy after {} attempts",
            MAX_HEALTH_ATTEMPTS
        )))
    }
}

impl Drop for LlamaServer {
    fn drop(&mut self) {
        if let Some(ref mut child) = self.child {
            let _ = child.start_kill();
        }
    }
}

/// Scan stderr lines for the port announcement from llama-server.
async fn find_port_from_stderr(stderr: tokio::process::ChildStderr) -> Result<u16, String> {
    let reader = tokio::io::BufReader::new(stderr);
    let mut lines = reader.lines();

    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        if let Some(caps) = PORT_RE.captures(&line) {
            let port: u16 = caps[1].parse().map_err(|e: std::num::ParseIntError| e.to_string())?;
            return Ok(port);
        }
    }
    Err("port not found in llama-server output".to_string())
}

/// Locate `llama-server` binary in the system PATH.
fn which_llama_server() -> Option<String> {
    for name in &["llama-server"] {
        if let Ok(output) = std::process::Command::new("which").arg(name).output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Some(path);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_llama_error_display() {
        let err = LlamaError::StartFailed("binary not found".to_string());
        assert!(err.to_string().contains("binary not found"));

        let err = LlamaError::ParseError("bad json".to_string());
        assert!(err.to_string().contains("bad json"));

        let err = LlamaError::RequestFailed("connection refused".to_string());
        assert!(err.to_string().contains("connection refused"));
    }

    #[test]
    fn test_which_llama_server_not_found() {
        // This just tests the function doesn't panic when binary is missing
        let result = which_llama_server();
        // May or may not find it depending on the system, just verify it returns Option
        let _ = result;
    }
}
