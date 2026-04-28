//! Pattern mining commands — expose via Tauri to UI and orchestrator

use crate::audit::store::AuditStore;
use crate::pii::engine::PiiEngine;
use crate::pii::pattern_miner::{self, PatternMiner};
use crate::state::SharedState;
use crate::gateway::GatewayClient;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{State, Manager};
use tokio::sync::RwLock;

/// Mining configuration passed by the UI or orchestrator.
#[derive(Debug, Clone, Deserialize)]
pub struct MiningConfigRequest {
    pub time_window_hours: i64,
    pub min_cluster_size: usize,
    pub min_confidence: f64,
    pub validation_sample_size: usize,
    pub auto_deploy: bool,
}

/// Response after a mining run completes (or fails).
#[derive(Debug, Clone, Serialize)]
pub struct MiningResult {
    pub success: bool,
    pub examples_collected: usize,
    pub clusters_formed: usize,
    pub patterns_generated: usize,
    pub patterns_validated: usize,
    pub patterns_pending: usize,
    pub message: String,
}

/// Start a pattern mining cycle (non-blocking). Returns immediately with a task handle.
#[tauri::command]
pub async fn start_pattern_mining(
    state: State<'_, SharedState>,
    gateway: State<'_, GatewayClient>,
    config: Option<MiningConfigRequest>,
) -> Result<String, String> {
    let app_state = state.read().await;

    // Ensure audit store is open
    let audit_store = match &*app_state.audit_store {
        Some(store) => store.clone(),
        None => return Err("Audit store not initialized".into()),
    };

    let pii_engine = app_state.pii_engine.clone();
    drop(app_state); // release lock early

    // Clone needed shared state for background task
    let shared_state: Arc<RwLock<crate::state::AppState>> = state.inner().clone();
    let gateway_client = gateway.inner().clone();

    // Spawn background task
    let task_handle = tokio::spawn(async move {
        let config = config.map(|r| pattern_miner::MiningConfig {
            time_window_hours: r.time_window_hours,
            min_cluster_size: r.min_cluster_size,
            min_confidence: r.min_confidence,
            validation_sample_size: r.validation_sample_size,
            auto_deploy: r.auto_deploy,
        }).unwrap_or_default();

        let miner = PatternMiner::new(shared_state, gateway_client, config);
        match miner.run("background-mining").await {
            Ok(_) => {
                tracing::info!("Pattern mining background task completed successfully");
            }
            Err(e) => {
                tracing::error!("Pattern mining failed: {e}");
            }
        }
    });

    // We don't await task; return an identifier
    Ok(format!("task-{:?}", task_handle.id()))
}

/// Execute a synchronous mining cycle (for CLI or orchestrator subtask). Blocks until done.
#[tauri::command]
pub async fn run_pattern_mining_sync(
    state: State<'_, SharedState>,
    gateway: State<'_, GatewayClient>,
    config: Option<MiningConfigRequest>,
) -> Result<MiningResult, String> {
    let app_state = state.read().await;

    let audit_store = match &*app_state.audit_store {
        Some(store) => store.clone(),
        None => return Err("Audit store not initialized".into()),
    };

    let pii_engine = app_state.pii_engine.clone();
    let shared_state = state.inner().clone();
    let gateway_client = gateway.inner().clone();

    drop(app_state);

    let config = config.map(|r| pattern_miner::MiningConfig {
        time_window_hours: r.time_window_hours,
        min_cluster_size: r.min_cluster_size,
        min_confidence: r.min_confidence,
        validation_sample_size: r.validation_sample_size,
        auto_deploy: r.auto_deploy,
    }).unwrap_or_default();

    let miner = PatternMiner::new(shared_state, gateway_client, config);
    miner.run("sync-mining").await.map_err(|e| e.to_string())?;

    // After run, build a result summary
    // (Could read from store stats if needed)
    Ok(MiningResult {
        success: true,
        examples_collected: 0, // TODO: fetch from progress store if needed
        clusters_formed: 0,
        patterns_generated: 0,
        patterns_validated: 0,
        patterns_pending: 0,
        message: "Mining cycle completed (check UI for pending patterns)".into(),
    })
}

/// Fetch pending pattern candidates awaiting approval.
#[tauri::command]
pub async fn get_pending_patterns(
    state: State<'_, SharedState>,
    task_id: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let app_state = state.read().await;
    let audit_store = match &*app_state.audit_store {
        Some(store) => store.clone(),
        None => return Err("Audit store not initialized".into()),
    };

    let candidates = audit_store
        .get_pending_candidates(task_id.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    // Convert to serde_json::Value for UI flexibility
    let json_values: Vec<serde_json::Value> = candidates
        .into_iter()
        .map(|c| serde_json::to_value(c).unwrap_or_default())
        .collect();

    Ok(json_values)
}

/// Approve a batch of pattern candidates — they will be deployed.
#[tauri::command]
pub async fn approve_patterns(
    state: State<'_, SharedState>,
    pattern_ids: Vec<String>,
) -> Result<usize, String> {
    let app_state = state.read().await;
    let audit_store = match &*app_state.audit_store {
        Some(store) => store.clone(),
        None => return Err("Audit store not initialized".into()),
    };
    let pii_engine = app_state.pii_engine.clone();
    drop(app_state);

    // Approve in DB
    let approved_count = audit_store.approve_candidates(&pattern_ids).await?;

    // Fetch approved pattern candidates to build recognizers
    let approved_patterns: Vec<crate::audit::store::PatternCandidate> = {
        let mut result = Vec::new();
        for pid in &pattern_ids {
            if let Some(cand) = audit_store.get_pattern_candidate(pid).await? {
                result.push(cand);
            }
        }
        result
    };

    // Convert to Recognizer for engine
    let recognizers: Vec<engine::Recognizer> = approved_patterns
        .into_iter()
        .map(|c| engine::Recognizer {
            entity_type: engine::PiiType::Custom(c.entity_type.clone()),
            pattern: c.generated_regex,
            validator: None, // In future: store validator in candidate?
        })
        .collect();

    // Deploy: load current custom recognizers file, append, save, hot-reload
    let recognizers_path = get_custom_recognizers_path()?;
    let mut current = if recognizers_path.exists() {
        let data = tokio::fs::read_to_string(&recognizers_path)
            .await
            .map_err(|e| format!("Failed to read recognizers: {e}"))?;
        serde_json::from_str(&data).unwrap_or_else(|_| Vec::new())
    } else {
        Vec::new()
    };

    // Merge: append new ones (avoid duplicates by pattern string)
    let existing_patterns: std::collections::HashSet<String> = current
        .iter()
        .map(|r| r.pattern.clone())
        .collect();
    for rec in &recognizers {
        if !existing_patterns.contains(&rec.pattern) {
            current.push(rec.clone());
        }
    }

    // Write atomically
    let tmp_path = recognizers_path.with_extension("json.tmp");
    tokio::fs::write(&tmp_path, serde_json::to_string_pretty(&current).unwrap())
        .await
        .map_err(|e| format!("Failed to write temp recognizers: {e}"))?;
    std::fs::rename(&tmp_path, &recognizers_path).map_err(|e| format!("Failed to rename: {e}"))?;

    // Hot-reload engine
    {
        let mut engine = pii_engine.write().await;
        engine.reload_external_recognizers().await?;
    }

    Ok(approved_count)
}

/// Reject a batch of pattern candidates (delete from DB).
#[tauri::command]
pub async fn reject_patterns(
    state: State<'_, SharedState>,
    pattern_ids: Vec<String>,
) -> Result<usize, String> {
    let app_state = state.read().await;
    let audit_store = match &*app_state.audit_store {
        Some(store) => store.clone(),
        None => return Err("Audit store not initialized".into()),
    };
    let count = audit_store.reject_candidates(&pattern_ids).await?;
    Ok(count)
}

/// Resolve the custom recognizers file path, respecting env var or default.
fn get_custom_recognizers_path() -> Result<PathBuf, String> {
    let data_local = dirs::data_local_dir()
        .ok_or_else(|| "Cannot determine data local directory".to_string())?;
    Ok(data_local
        .join("aelvyril")
        .join("custom_recognizers.json"))
}
