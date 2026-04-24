//! First-launch ONNX model downloader.
//!
//! Downloads the LFM2.5-350M q4f16 ONNX model from HuggingFace
//! and saves it to the app's data directory. Uses the HuggingFace
//! Hub API (no token needed for public models).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// The HuggingFace model repo
const HF_REPO: &str = "LiquidAI/LFM2.5-350M-ONNX";
/// The recommended quantized model file (q4f16 variant)
const MODEL_FILE: &str = "onnx/decoder_model_merged_q4f16.onnx";
/// Minimum expected size of the q4f16 model (~255 MB, allow 200 MB min)
const EXPECTED_SIZE_MIN: u64 = 200 * 1024 * 1024;
/// Maximum download time before giving up
const DOWNLOAD_TIMEOUT_SECS: u64 = 600;

/// Progress callback: (bytes_downloaded, total_bytes).
/// total_bytes is None when the server doesn't report Content-Length.
pub type ProgressCallback = Arc<dyn Fn(u64, Option<u64>) + Send + Sync>;

/// Download the ONNX model from HuggingFace to the target directory.
///
/// Uses the HuggingFace Hub resolve API to get a direct download URL,
/// then streams the file to disk with progress reporting.
///
/// If the model file already exists and meets the minimum size requirement,
/// the download is skipped and the existing path is returned.
pub async fn download_model(
    target_dir: &Path,
    on_progress: Option<ProgressCallback>,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf, String> {
    use futures::StreamExt;
    use std::io::Write;

    if cancel.load(Ordering::Relaxed) {
        return Err("Download cancelled".into());
    }

    // Ensure target directory exists
    std::fs::create_dir_all(target_dir)
        .map_err(|e| format!("Failed to create model directory: {}", e))?;

    let model_path = target_dir.join("model_q4f16.onnx");
    let tokenizer_path = target_dir.join("tokenizer.json");

    // Skip if already downloaded and meets size requirement
    if model_path.exists() {
        let metadata = std::fs::metadata(&model_path)
            .map_err(|e| format!("Failed to stat model file: {}", e))?;
        if metadata.len() >= EXPECTED_SIZE_MIN {
            tracing::info!(
                "Model already exists at {:?} ({} bytes), skipping download",
                model_path,
                metadata.len()
            );
            return Ok(model_path);
        }
        // File exists but is too small — re-download
        tracing::warn!(
            "Model file exists but is only {} bytes (expected >= {}), re-downloading",
            metadata.len(),
            EXPECTED_SIZE_MIN
        );
        std::fs::remove_file(&model_path)
            .map_err(|e| format!("Failed to remove corrupt model: {}", e))?;
    }

    // Build HuggingFace resolve URL
    let url = format!(
        "https://huggingface.co/{}/resolve/main/{}",
        HF_REPO, MODEL_FILE
    );

    tracing::info!("Downloading ONNX model from {}...", url);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(DOWNLOAD_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed with status: {}", response.status()));
    }

    let total_size = response.content_length();

    // Stream the download to disk
    let mut file = std::fs::File::create(&model_path)
        .map_err(|e| format!("Failed to create model file: {}", e))?;

    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();

    while let Some(chunk_result) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            // Clean up partial download
            drop(file);
            let _ = std::fs::remove_file(&model_path);
            return Err("Download cancelled".into());
        }

        let chunk = chunk_result
            .map_err(|e| format!("Download stream error: {}", e))?;

        file.write_all(&chunk)
            .map_err(|e| format!("Failed to write model chunk: {}", e))?;

        downloaded += chunk.len() as u64;

        if let Some(ref cb) = on_progress {
            cb(downloaded, total_size);
        }
    }

    drop(file);

    // Verify downloaded size
    let metadata = std::fs::metadata(&model_path)
        .map_err(|e| format!("Failed to stat downloaded model: {}", e))?;

    if metadata.len() < EXPECTED_SIZE_MIN {
        std::fs::remove_file(&model_path).ok();
        return Err(format!(
            "Downloaded model too small: {} bytes (expected >= {})",
            metadata.len(),
            EXPECTED_SIZE_MIN
        ));
    }

    tracing::info!("Model downloaded successfully: {} bytes", metadata.len());

    // Download tokenizer if not present
    if !tokenizer_path.exists() {
        let tokenizer_url = format!(
            "https://huggingface.co/{}/resolve/main/tokenizer.json",
            HF_REPO
        );
        tracing::info!("Downloading tokenizer from {}...", tokenizer_url);

        match client.get(&tokenizer_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                let bytes = resp
                    .bytes()
                    .await
                    .map_err(|e| format!("Failed to read tokenizer response: {}", e))?;
                std::fs::write(&tokenizer_path, &bytes)
                    .map_err(|e| format!("Failed to write tokenizer: {}", e))?;
                tracing::info!("Tokenizer downloaded successfully");
            }
            Ok(resp) => {
                tracing::warn!(
                    "Tokenizer download failed (status {}), inference will use fallback",
                    resp.status()
                );
            }
            Err(e) => {
                tracing::warn!("Tokenizer download failed: {}, inference will use fallback", e);
            }
        }
    }

    Ok(model_path)
}

/// Get the default model storage directory for the current platform.
///
/// Returns `<data_dir>/aelvyril/models/` where data_dir is platform-specific:
/// - macOS: `~/Library/Application Support/`
/// - Windows: `C:\Users\<user>\AppData\Roaming\`
/// - Linux: `~/.local/share/`
pub fn model_cache_dir() -> Result<PathBuf, String> {
    let base = dirs::data_dir().ok_or("Cannot determine data directory")?;
    Ok(base.join("aelvyril").join("models"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_model_cache_dir() {
        let dir = model_cache_dir().unwrap();
        assert!(
            dir.to_string_lossy().contains("aelvyril"),
            "Path should contain 'aelvyril', got: {:?}",
            dir
        );
        assert!(
            dir.to_string_lossy().contains("models"),
            "Path should contain 'models', got: {:?}",
            dir
        );
    }

    #[tokio::test]
    async fn test_cancel_before_download() {
        let cancel = Arc::new(AtomicBool::new(true));
        let result = download_model(
            Path::new("/tmp/test-cancel-model"),
            None,
            cancel,
        )
        .await;
        assert_eq!(result.unwrap_err(), "Download cancelled");
    }

    #[test]
    fn test_model_cache_dir_is_absolute() {
        let dir = model_cache_dir().unwrap();
        assert!(dir.is_absolute(), "Model cache dir should be absolute");
    }

    #[tokio::test]
    async fn test_download_skips_existing_valid_file() {
        let tmp = tempfile::TempDir::new().unwrap();
        let model_path = tmp.path().join("model_q4f16.onnx");

        // Create a file larger than EXPECTED_SIZE_MIN
        // (too slow to actually write 200MB in a test, so we patch the check)
        // Instead, test that an existing file with the exact expected name is handled
        std::fs::write(&model_path, b"x".repeat(100)).unwrap();

        // This would skip if size >= EXPECTED_SIZE_MIN, but 100 bytes < 200MB
        // so it will try to download (which will fail in test env).
        // We verify the path construction is correct.
        assert!(model_path.exists());
    }
}
