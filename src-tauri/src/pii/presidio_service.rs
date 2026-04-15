//! Manages the local Presidio analyzer Python service lifecycle.
//!
//! Starts the `presidio_service.py` Python microservice when the Tauri app launches
//! and ensures it's stopped when the app exits.

use std::process::{Child, Command, Stdio};
use tracing;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: &str = "3000";

/// Manages the Presidio Python child process.
pub struct PresidioService {
    child: Option<Child>,
    host: String,
    port: String,
}

impl Default for PresidioService {
    fn default() -> Self {
        Self::new()
    }
}

impl PresidioService {
    pub fn new() -> Self {
        Self {
            child: None,
            host: DEFAULT_HOST.to_string(),
            port: DEFAULT_PORT.to_string(),
        }
    }

    /// Configure a custom host and port
    pub fn with_address(host: &str, port: u16) -> Self {
        Self {
            child: None,
            host: host.to_string(),
            port: port.to_string(),
        }
    }

    /// Get the base URL the service will run on
    pub fn base_url(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }

    /// Start the Presidio Python service as a child process.
    ///
    /// Looks for the service script in multiple locations:
    /// 1. Explicit `script_path` if provided
    /// 2. Next to the app executable
    /// 3. In the Tauri resource directory
    pub fn start(&mut self, script_path: Option<&std::path::Path>) -> Result<(), String> {
        if self.child.is_some() {
            tracing::debug!("Presidio service already running");
            return Ok(());
        }

        let resolved_path = if let Some(path) = script_path {
            if path.exists() {
                path.to_path_buf()
            } else {
                return Err(format!(
                    "Presidio script not found at provided path: {:?}",
                    path
                ));
            }
        } else {
            // Find the service script next to the app executable
            let exe_dir = std::env::current_exe()
                .map_err(|e| format!("Cannot find executable path: {}", e))?
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| std::path::PathBuf::from("."));

            let candidates = [
                exe_dir.join("presidio_service.py"),
                exe_dir.join("../presidio_service.py"),
                exe_dir.join("../../presidio_service.py"),
                // Dev mode: src-tauri directory
                std::path::PathBuf::from("presidio_service.py"),
            ];

            candidates
                .clone()
                .into_iter()
                .find(|p| p.exists())
                .ok_or_else(|| {
                    format!(
                        "Presidio service script not found (searched: {:?})",
                        candidates
                    )
                })?
        };

        tracing::info!("Starting Presidio service from: {:?}", resolved_path);

        // Prefer uv run with the venv (dev mode), otherwise fall back to system python3
        let venv_dir = resolved_path
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join(".venv");
        let venv_python = venv_dir.join("bin/python");

        let (cmd, args): (std::path::PathBuf, Vec<std::path::PathBuf>) = if venv_python.exists() {
            // Use uv run to properly activate the venv
            tracing::info!("Using uv run with venv: {:?}", venv_dir);
            (
                std::path::PathBuf::from("uv"),
                vec![
                    std::path::PathBuf::from("run"),
                    std::path::PathBuf::from("--python"),
                    venv_python.clone(),
                    resolved_path.clone(),
                ],
            )
        } else {
            tracing::info!("Using system python3");
            (
                std::path::PathBuf::from("python3"),
                vec![resolved_path.clone()],
            )
        };

        let mut command = Command::new(&cmd);
        let child = command
            .args(&args)
            .env("PRESIDIO_HOST", &self.host)
            .env("PRESIDIO_PORT", &self.port)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start Presidio service: {}", e))?;

        tracing::info!(
            "Presidio service started (PID: {:?}) on {}",
            child.id(),
            self.base_url()
        );

        self.child = Some(child);
        Ok(())
    }

    /// Stop the Presidio service by killing the child process.
    pub fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            tracing::info!("Stopping Presidio service (PID: {:?})", child.id());

            match child.kill() {
                Ok(_) => {
                    let _ = child.wait(); // Reap the process
                    tracing::info!("Presidio service stopped");
                }
                Err(e) => {
                    tracing::warn!("Failed to kill Presidio service: {}", e);
                }
            }
        }
    }

    /// Check if the service process is still running.
    pub fn is_running(&mut self) -> bool {
        match &mut self.child {
            Some(child) => {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        tracing::warn!(
                            "Presidio service exited unexpectedly with status: {}",
                            status
                        );
                        self.child = None;
                        false
                    }
                    Ok(None) => true, // Still running
                    Err(e) => {
                        tracing::warn!("Failed to check Presidio service status: {}", e);
                        false
                    }
                }
            }
            None => false,
        }
    }
}

impl Drop for PresidioService {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_base_url() {
        let svc = PresidioService::with_address("127.0.0.1", 3000);
        assert_eq!(svc.base_url(), "http://127.0.0.1:3000");
    }

    #[test]
    fn test_custom_port() {
        let svc = PresidioService::with_address("localhost", 5000);
        assert_eq!(svc.base_url(), "http://localhost:5000");
    }
}
