//! Tauri commands for the orchestrator.

use std::path::PathBuf;

use crate::orchestrator;
use crate::orchestrator::state_store::OrchestratorStore;
use crate::orchestrator::types::*;
use crate::state::SharedState;

/// Resolve the default repo path for orchestrator tasks.
///
/// For now, uses the current working directory. Future: could be
/// configurable per-task or derived from the frontend.
fn default_repo_path() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Open the orchestrator SQLite store.
fn open_store() -> Result<OrchestratorStore, String> {
    OrchestratorStore::open_default()
        .map_err(|e| format!("Failed to open orchestrator store: {e}"))
}

#[tauri::command]
pub async fn start_orchestrator_task(
    request: String,
    state: tauri::State<'_, SharedState>,
    orch_state: tauri::State<'_, orchestrator::SharedOrchState>,
) -> Result<String, String> {
    // Pre-flight checks
    let app = state.read().await;
    let preflight = orchestrator::preflight(&app).await
        .map_err(|e| format!("Pre-flight error: {e}"))?;

    if !preflight.passed {
        return Err(preflight.blocking_reason.unwrap_or("Pre-flight failed".into()));
    }
    drop(app);

    // Create task
    let task = Task::new(request, TaskMode::Direct);
    let task_id = task.id.clone();

    // Initialize state
    let orch_state_obj = OrchState::new(task);

    // Create cancellation watch channel — the sender is stored in OrchState
    // so cancel_orchestrator_task can signal the executor to kill pi immediately.
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    let mut orch_state_obj = orch_state_obj;
    orch_state_obj.cancel_tx = Some(cancel_tx);

    {
        let mut orch = orch_state.write().await;
        orch.tasks.insert(task_id.clone(), orch_state_obj.clone());
    }

    // Persist to SQLite
    let store = open_store()?;
    let _ = store.save_task(&orch_state_obj.task);
    let _ = store.save_orch_state(&orch_state_obj);

    // Clone what we need for the background task
    let app_state = state.inner().clone();
    let orch_shared = orch_state.inner().clone();
    let repo_path = default_repo_path();
    let bg_task_id = task_id.clone();

    // Spawn the state machine as a background task
    tokio::spawn(async move {
        if let Err(e) = orchestrator::run_task(
            bg_task_id.clone(),
            &repo_path,
            app_state,
            orch_shared,
            store,
            cancel_rx,
        )
        .await
        {
            tracing::error!("Orchestrator task {} failed: {}", bg_task_id, e);
        }
    });

    Ok(task_id)
}

#[tauri::command]
pub async fn get_orchestrator_state(
    task_id: String,
    orch_state: tauri::State<'_, orchestrator::SharedOrchState>,
) -> Result<serde_json::Value, String> {
    let orch = orch_state.read().await;
    let state = orch
        .tasks
        .get(&task_id)
        .ok_or_else(|| format!("Task not found: {task_id}"))?;

    serde_json::to_value(state).map_err(|e| format!("Serialization error: {e}"))
}

#[tauri::command]
pub async fn get_orchestrator_task_list(
    orch_state: tauri::State<'_, orchestrator::SharedOrchState>,
) -> Result<serde_json::Value, String> {
    let orch = orch_state.read().await;
    let tasks: Vec<serde_json::Value> = orch
        .tasks
        .values()
        .map(|s| {
            serde_json::json!({
                "id": s.task.id,
                "request": s.task.user_request,
                "status": serde_json::to_value(&s.task.status).unwrap_or(serde_json::Value::Null),
                "phase": serde_json::to_value(&s.phase).unwrap_or(serde_json::Value::Null),
                "created_at": s.task.created_at,
                "completed_at": s.task.completed_at,
            })
        })
        .collect();

    Ok(serde_json::json!({ "tasks": tasks }))
}

#[tauri::command]
pub async fn get_orchestrator_plan(
    task_id: String,
    orch_state: tauri::State<'_, orchestrator::SharedOrchState>,
) -> Result<serde_json::Value, String> {
    let orch = orch_state.read().await;
    let state = orch
        .tasks
        .get(&task_id)
        .ok_or_else(|| format!("Task not found: {task_id}"))?;

    Ok(serde_json::json!({ "plan": state.plan }))
}

#[tauri::command]
pub async fn get_execution_result(
    task_id: String,
    orch_state: tauri::State<'_, orchestrator::SharedOrchState>,
) -> Result<Option<ExecutionResult>, String> {
    let orch = orch_state.read().await;
    let state = orch
        .tasks
        .get(&task_id)
        .ok_or_else(|| format!("Task not found: {task_id}"))?;
    Ok(state.execution_result.clone())
}

#[tauri::command]
pub async fn get_validation_result(
    task_id: String,
    orch_state: tauri::State<'_, orchestrator::SharedOrchState>,
) -> Result<Option<ValidationResult>, String> {
    let orch = orch_state.read().await;
    let state = orch
        .tasks
        .get(&task_id)
        .ok_or_else(|| format!("Task not found: {task_id}"))?;
    Ok(state.validation_result.clone())
}

#[tauri::command]
pub async fn cancel_orchestrator_task(
    task_id: String,
    orch_state: tauri::State<'_, orchestrator::SharedOrchState>,
) -> Result<(), String> {
    let mut orch = orch_state.write().await;
    let state = orch
        .tasks
        .get_mut(&task_id)
        .ok_or_else(|| format!("Task not found: {task_id}"))?;

    // Signal the background loop to stop by setting the cancelled flag.
    // The loop checks this flag at the start of each iteration and will
    // break out, clean up any running pi subprocess, and persist state.
    state.cancelled = true;
    state.task.completed_at = Some(chrono::Utc::now());

    // Also signal via the watch channel so the pi executor can kill
    // the subprocess immediately without waiting for a timeout.
    if let Some(ref tx) = state.cancel_tx {
        let _ = tx.send(true);
    }

    // Persist
    let store = open_store()?;
    let _ = store.save_task(&state.task);
    let _ = store.save_orch_state(state);

    Ok(())
}

#[tauri::command]
pub async fn respond_to_blocked(
    task_id: String,
    user_input: String,
    state: tauri::State<'_, SharedState>,
    orch_state: tauri::State<'_, orchestrator::SharedOrchState>,
) -> Result<serde_json::Value, String> {
    // Guard: only proceed if the task is still in Blocked state.
    // If called twice quickly, the second call will see phase=Plan and bail out,
    // preventing duplicate run_task spawns.
    {
        let orch = orch_state.read().await;
        let task_state = orch
            .tasks
            .get(&task_id)
            .ok_or_else(|| format!("Task not found: {task_id}"))?;
        if task_state.phase != orchestrator::types::OrchestratorPhase::Blocked {
            return Err(format!(
                "Task is not in Blocked state (current: {:?})",
                task_state.phase
            ));
        }
    }

    orchestrator::continue_blocked_task(&task_id, &user_input, orch_state.inner())
        .await
        .map_err(|e| format!("Failed to continue task: {e}"))?;

    // Re-spawn the state machine
    let app_state = state.inner().clone();
    let orch_shared = orch_state.inner().clone();
    let repo_path = default_repo_path();
    let bg_task_id = task_id.clone();

    // Create a new cancellation channel for the continued task
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    {
        let mut orch = orch_state.write().await;
        if let Some(st) = orch.tasks.get_mut(&task_id) {
            st.cancel_tx = Some(cancel_tx);
        }
    }

    // Re-open store for the background task
    let store = open_store()?;

    tokio::spawn(async move {
        if let Err(e) = orchestrator::run_task(
            bg_task_id.clone(),
            &repo_path,
            app_state,
            orch_shared,
            store,
            cancel_rx,
        )
        .await
        {
            tracing::error!(
                "Orchestrator task {} failed after continue: {}",
                bg_task_id,
                e
            );
        }
    });

    // Return current state
    let orch = orch_state.read().await;
    let state = orch.tasks.get(&task_id).ok_or("Task not found")?;
    serde_json::to_value(state).map_err(|e| format!("Serialization error: {e}"))
}

#[tauri::command]
pub async fn get_orchestrator_settings(
    state: tauri::State<'_, SharedState>,
) -> Result<OrchestratorSettings, String> {
    let app = state.read().await;
    Ok(app.settings.orchestrator.clone())
}

#[tauri::command]
pub async fn update_orchestrator_settings(
    settings: OrchestratorSettings,
    state: tauri::State<'_, SharedState>,
) -> Result<(), String> {
    let mut app = state.write().await;
    app.settings.orchestrator = settings;
    crate::config::store::save_settings(&app.settings)
}
