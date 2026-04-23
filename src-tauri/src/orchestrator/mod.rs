//! Aelvyril Orchestrator — plan-and-execute coding agent.
//!
//! State machine that:
//! 1. Receives user requests (coding tasks)
//! 2. Optionally plans via an LLM through Aelvyril's gateway
//! 3. Executes subtasks via pi (RPC subprocess)
//! 4. Validates results with whitelisted test commands
//! 5. Replans on failure

pub mod context;
pub mod contracts;
pub mod errors;
pub mod executor;
pub mod planner;
pub mod state_store;
pub mod types;
pub mod validator;

use std::path::Path;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::config;
use crate::state::{AppState, SharedState};

use self::errors::OrchestratorError;
use self::types::*;
use self::state_store::OrchestratorStore;

/// Shared orchestrator state, managed as a Tauri resource.
pub type SharedOrchState = Arc<RwLock<OrchestratorState>>;

// ── Pre-flight Checks ────────────────────────────────────────────────────────

/// Result of pre-flight checks.
pub struct PreflightResult {
    pub passed: bool,
    pub blocking_reason: Option<String>,
    pub gateway_port: u16,
    pub gateway_key: String,
}

/// Run all pre-flight checks before entering the orchestrator state machine.
///
/// Checks:
/// 1. Gateway running (port listening)
/// 2. Providers configured
/// 3. Planning model configured
/// 4. Executor model configured
/// 5. Planning model resolvable to a provider
/// 6. Executor model resolvable to a provider
/// 7. pi installed
/// 8. pi models.json has aelvyril provider (auto-fix if missing)
pub async fn preflight(app_state: &AppState) -> Result<PreflightResult, OrchestratorError> {
    let config = &app_state.settings.orchestrator;

    // 1. Gateway running?
    let gateway_key = app_state
        .gateway_key
        .as_ref()
        .ok_or(OrchestratorError::GatewayNotRunning)?
        .clone();
    let gateway_port = app_state.gateway_port;

    // Quick check: can we reach the gateway?
    let url = format!("http://localhost:{gateway_port}/v1/models");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|e| OrchestratorError::Other(format!("HTTP client error: {e}")))?;

    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {}
        _ => {
            return Ok(PreflightResult {
                passed: false,
                blocking_reason: Some("Gateway is not running. Start Aelvyril gateway first.".into()),
                gateway_port,
                gateway_key,
            });
        }
    }

    // 2. Providers configured?
    if app_state.providers.is_empty() {
        return Ok(PreflightResult {
            passed: false,
            blocking_reason: Some("No upstream providers configured. Add a provider first.".into()),
            gateway_port,
            gateway_key,
        });
    }

    // 3. Planning model configured?
    if config.planning_model.is_empty() {
        return Ok(PreflightResult {
            passed: false,
            blocking_reason: Some("Planning model not configured. Set orchestrator.planning_model in settings.".into()),
            gateway_port,
            gateway_key,
        });
    }

    // 4. Executor model configured?
    if config.executor_model.is_empty() {
        return Ok(PreflightResult {
            passed: false,
            blocking_reason: Some("Executor model not configured. Set orchestrator.executor_model in settings.".into()),
            gateway_port,
            gateway_key,
        });
    }

    // 5. Planning model resolves to a provider?
    if config::find_provider_for_model(&app_state.providers, &config.planning_model).is_none() {
        return Ok(PreflightResult {
            passed: false,
            blocking_reason: Some(format!(
                "No provider configured for planning model '{}'. Add a provider that supports this model.",
                config.planning_model
            )),
            gateway_port,
            gateway_key,
        });
    }

    // 6. Executor model resolves to a provider?
    if config::find_provider_for_model(&app_state.providers, &config.executor_model).is_none() {
        return Ok(PreflightResult {
            passed: false,
            blocking_reason: Some(format!(
                "No provider configured for executor model '{}'. Add a provider that supports this model.",
                config.executor_model
            )),
            gateway_port,
            gateway_key,
        });
    }

    // 7. pi installed?
    if let Err(e) = executor::check_pi_installed().await {
        return Ok(PreflightResult {
            passed: false,
            blocking_reason: Some(format!("{e}")),
            gateway_port,
            gateway_key,
        });
    }

    // 8. pi models.json has aelvyril provider (auto-fix)
    if let Err(e) = executor::ensure_pi_aelvyril_provider(
        gateway_port,
        &gateway_key,
        &config.executor_model,
        &config.planning_model,
    )
    .await
    {
        return Ok(PreflightResult {
            passed: false,
            blocking_reason: Some(format!("pi configuration error: {e}")),
            gateway_port,
            gateway_key,
        });
    }

    Ok(PreflightResult {
        passed: true,
        blocking_reason: None,
        gateway_port,
        gateway_key,
    })
}

// ── State Machine ────────────────────────────────────────────────────────────

/// Run the orchestrator state machine for a single task.
///
/// This is spawned as a background tokio task. It reads/writes orchestrator
/// state via the shared `SharedOrchState` and persists to SQLite.
pub async fn run_task(
    task_id: String,
    repo_path: &Path,
    app_state: SharedState,
    orch_state: SharedOrchState,
    store: OrchestratorStore,
    cancel_rx: tokio::sync::watch::Receiver<bool>,
) -> Result<(), OrchestratorError> {
    // Load initial state
    let (_gateway_port, gateway_key, config) = {
        let app = app_state.read().await;
        let config = app.settings.orchestrator.clone();
        let gateway_key = app
            .gateway_key
            .clone()
            .ok_or(OrchestratorError::GatewayNotRunning)?;
        (app.gateway_port, gateway_key, config)
    };

    // Load or create task state
    let mut state = {
        let orch = orch_state.read().await;
        orch.tasks.get(&task_id).cloned().ok_or_else(|| {
            OrchestratorError::TaskNotFound(task_id.clone())
        })?
    };

    let max_retries = config.max_subtask_retries;

    // Main state machine loop
    loop {
        // Check cancellation flag written by `cancel_orchestrator_task`.
        // We re-read from shared state each iteration so the cancel signal
        // is picked up within one phase transition (not just persist_state).
        {
            let orch = orch_state.read().await;
            if let Some(orch_task) = orch.tasks.get(&task_id) {
                if orch_task.cancelled {
                    tracing::info!("Orchestrator task {task_id} cancelled, exiting loop");
                    state.transition_to(OrchestratorPhase::Done);
                    state.task.status = TaskStatus::Cancelled;
                    persist_state(&store, &mut state, &orch_state).await;
                    break Ok(());
                }
            }
        }

        match state.phase {
            OrchestratorPhase::Intake => {
                // Build repo context for planning
                let repo_summary = context::build_repo_tree_summary(repo_path);
                let planning_context = PlanningContext {
                    user_goal: state.task.user_request.clone(),
                    repo_tree_summary: repo_summary,
                    ..Default::default()
                };

                // Check if we need planning
                if planner::needs_planning(&state.task.user_request) {
                    state.task.mode = TaskMode::Planned;
                    state.transition_to(OrchestratorPhase::Plan);
                } else {
                    state.task.mode = TaskMode::Direct;
                    // Auto-generate a single-step plan
                    let plan = make_single_step_plan(
                        &state.task,
                        &planning_context,
                    );
                    state.plan = Some(plan);
                    state.transition_to(OrchestratorPhase::SelectSubtask);
                }

                // Persist + update shared state
                persist_state(&store, &mut state, &orch_state).await;
            }

            OrchestratorPhase::Plan => {
                tracing::info!("Planning task: {}", state.task.user_request);

                let repo_summary = context::build_repo_tree_summary(repo_path);
                let planning_context = PlanningContext {
                    user_goal: state.task.user_request.clone(),
                    repo_tree_summary: repo_summary,
                    previous_failures: state.error_log.clone(),
                    ..Default::default()
                };

                match planner::create_plan(
                    &state.task.user_request,
                    &planning_context,
                    &config,
                    &app_state,
                )
                .await
                {
                    Ok(mut plan) => {
                        plan.task_id = state.task.id.clone();
                        state.plan = Some(plan);
                        state.retry_count = 0;
                        state.transition_to(OrchestratorPhase::ParsePlan);
                    }
                    Err(e) => {
                        state.log_error(format!("Planning failed: {e}"));
                        if state.retry_count < 2 {
                            state.retry_count += 1;
                            tracing::warn!(
                                "Planning retry {}/{}: {}",
                                state.retry_count,
                                2,
                                e
                            );
                            // Stay in Plan phase for retry
                        } else {
                            state.transition_to(OrchestratorPhase::Blocked);
                            state.log_error(
                                "Planning model failed after retries. Provide manual guidance or cancel.",
                            );
                        }
                    }
                }

                persist_state(&store, &mut state, &orch_state).await;
            }

            OrchestratorPhase::ParsePlan => {
                // Validate the plan has required structure
                match &state.plan {
                    Some(plan) if !plan.subtasks.is_empty() => {
                        tracing::info!(
                            "Plan validated: {} subtasks",
                            plan.subtasks.len()
                        );
                        // Save plan to SQLite
                        let _ = store.save_plan(plan);
                        state.retry_count = 0;
                        state.transition_to(OrchestratorPhase::SelectSubtask);
                    }
                    Some(_) => {
                        // Empty subtasks
                        state.log_error("Plan has no subtasks");
                        if state.retry_count < 2 {
                            state.retry_count += 1;
                            state.plan = None;
                            state.transition_to(OrchestratorPhase::Plan);
                        } else {
                            state.transition_to(OrchestratorPhase::Blocked);
                            state.log_error("Planning model returning invalid plans. Provide manual guidance.");
                        }
                    }
                    None => {
                        state.log_error("No plan available to parse");
                        state.transition_to(OrchestratorPhase::Plan);
                    }
                }

                persist_state(&store, &mut state, &orch_state).await;
            }

            OrchestratorPhase::SelectSubtask => {
                let next_subtask = state.plan.as_ref().and_then(|plan| {
                    plan.subtasks.iter().find(|s| {
                        s.status == SubtaskStatus::Pending && s.dependencies_met(&plan.subtasks)
                    })
                });

                match next_subtask {
                    Some(st) => {
                        let subtask_id = st.id.clone();
                        tracing::info!("Selected subtask: {} — {}", subtask_id, st.title);
                        state.current_subtask = Some(subtask_id);
                        state.task.status = TaskStatus::Executing;
                        state.retry_count = 0;
                        state.validation_retry_count = 0;
                        state.transition_to(OrchestratorPhase::Execute);
                    }
                    None => {
                        // Check if all subtasks are completed
                        let all_done = state.plan.as_ref().map_or(true, |plan| {
                            plan.subtasks.iter().all(|s| s.status == SubtaskStatus::Completed)
                        });

                        if all_done {
                            state.transition_to(OrchestratorPhase::Done);
                        } else {
                            // Some subtasks are failed/blocked but no dependencies are met
                            state.log_error("No executable subtask — all remaining subtasks have unmet dependencies or are blocked");
                            state.transition_to(OrchestratorPhase::Blocked);
                        }
                    }
                }

                persist_state(&store, &mut state, &orch_state).await;
            }

            OrchestratorPhase::Execute => {
                let subtask_id = state.current_subtask.clone().unwrap_or_default();
                let subtask = state
                    .plan
                    .as_ref()
                    .and_then(|plan| plan.subtasks.iter().find(|s| s.id == subtask_id))
                    .cloned();

                let subtask = match subtask {
                    Some(s) => s,
                    None => {
                        state.log_error("No current subtask to execute");
                        state.transition_to(OrchestratorPhase::SelectSubtask);
                        persist_state(&store, &mut state, &orch_state).await;
                        continue;
                    }
                };

                // Mark subtask as executing
                if let Some(plan) = state.plan.as_mut() {
                    if let Some(st) = plan.subtasks.iter_mut().find(|s| s.id == subtask_id) {
                        st.status = SubtaskStatus::Executing;
                    }
                }
                persist_state(&store, &mut state, &orch_state).await;

                tracing::info!("Executing subtask: {} — {}", subtask.id, subtask.title);

                let exec_context = ExecutorContext {
                    subtask_id: subtask.id.clone(),
                    subtask_description: subtask.description.clone(),
                    allowed_files: subtask.allowed_files.clone(),
                    constraints: subtask.constraints.clone(),
                    acceptance_criteria: subtask.acceptance_criteria.clone(),
                    previous_errors: if state.retry_count > 0 {
                        Some(state.error_log.clone())
                    } else {
                        None
                    },
                    repo_path: Some(repo_path.to_string_lossy().to_string()),
                };

                match executor::spawn_pi_executor(
                    &subtask,
                    &exec_context,
                    &config,
                    &gateway_key,
                    Some(repo_path.to_str().unwrap_or(".")),
                    &cancel_rx,
                )
                .await
                {
                    Ok(spawn_result) => {
                        let exec_result = executor::build_execution_result(
                            &subtask_id,
                            spawn_result,
                        );

                        // Save execution result
                        let _ = store.save_execution_result(&exec_result);

                        // Store result in state for PARSE_EXECUTION phase
                        state.execution_result = Some(exec_result);
                        state.transition_to(OrchestratorPhase::ParseExecution);
                    }
                    Err(OrchestratorError::ExecutorTimeout(secs)) => {
                        state.log_error(format!("Executor timed out after {secs}s"));
                        state.execution_result = None;
                        state.transition_to(OrchestratorPhase::Replan);
                    }
                    Err(OrchestratorError::ToolCallLimit(count)) => {
                        state.log_error(format!("Executor exceeded tool call limit ({count})"));
                        state.execution_result = None;
                        state.transition_to(OrchestratorPhase::Replan);
                    }
                    Err(OrchestratorError::PiNotInstalled) => {
                        state.log_error("pi is not installed");
                        state.transition_to(OrchestratorPhase::Blocked);
                    }
                    Err(OrchestratorError::ExecutorCrashed(msg)) => {
                        state.log_error(format!("Executor crashed: {msg}"));
                        state.transition_to(OrchestratorPhase::Blocked);
                    }
                    Err(e) => {
                        state.log_error(format!("Execution error: {e}"));
                        if state.retry_count < max_retries {
                            state.retry_count += 1;
                            // Stay in Execute for retry
                        } else {
                            state.transition_to(OrchestratorPhase::Replan);
                        }
                    }
                }

                persist_state(&store, &mut state, &orch_state).await;
            }

            OrchestratorPhase::ParseExecution => {
                let exec_result = state.execution_result.clone();
                let _subtask_id = state.current_subtask.clone().unwrap_or_default();

                match exec_result {
                    Some(result) if result.needs_replan => {
                        // Scope violation
                        state.log_error(format!(
                            "Executor exceeded file scope: {}",
                            result.files_outside_scope.join(", ")
                        ));
                        state.transition_to(OrchestratorPhase::Replan);
                    }
                    Some(result) if !result.pi_completed && result.tool_calls_made == 0 => {
                        // No output
                        if state.retry_count < max_retries {
                            state.retry_count += 1;
                            state.log_error("Executor produced no output, retrying with clarification");
                            state.transition_to(OrchestratorPhase::Execute);
                        } else {
                            state.log_error("Executor produced no output after retries");
                            state.transition_to(OrchestratorPhase::Replan);
                        }
                    }
                    Some(_) => {
                        // Execution looks good, move to validation
                        state.retry_count = 0;
                        state.transition_to(OrchestratorPhase::Validate);
                    }
                    None => {
                        state.log_error("No execution result available");
                        state.transition_to(OrchestratorPhase::Execute);
                    }
                }

                persist_state(&store, &mut state, &orch_state).await;
            }

            OrchestratorPhase::Validate => {
                let subtask_id = state.current_subtask.clone().unwrap_or_default();
                let subtask = state
                    .plan
                    .as_ref()
                    .and_then(|plan| plan.subtasks.iter().find(|s| s.id == subtask_id))
                    .cloned();

                let subtask = match subtask {
                    Some(s) => s,
                    None => {
                        state.log_error("No subtask to validate");
                        state.transition_to(OrchestratorPhase::SelectSubtask);
                        persist_state(&store, &mut state, &orch_state).await;
                        continue;
                    }
                };

                tracing::info!("Validating subtask: {}", subtask.id);

                let validation_result = validator::run_validation(
                    &subtask,
                    &config.allowed_test_commands,
                    Some(repo_path),
                )
                .await;

                // Save validation result
                let _ = store.save_validation_result(&validation_result);

                match validation_result.status {
                    ValidationStatus::Pass => {
                        state.retry_count = 0;
                        state.validation_retry_count = 0;
                        state.validation_result = Some(validation_result);
                        state.transition_to(OrchestratorPhase::CompleteSubtask);
                    }
                    ValidationStatus::Fail => {
                        state.log_error(format!(
                            "Validation failed: {}",
                            validation_result.errors.join("; ")
                        ));
                        if state.validation_retry_count < max_retries {
                            state.validation_retry_count += 1;
                            // Augment error log for executor retry
                            for err in &validation_result.errors {
                                state.log_error(err.clone());
                            }
                            state.transition_to(OrchestratorPhase::Execute);
                        } else {
                            state.validation_result = Some(validation_result);
                            state.transition_to(OrchestratorPhase::Replan);
                        }
                    }
                }

                persist_state(&store, &mut state, &orch_state).await;
            }

            OrchestratorPhase::CompleteSubtask => {
                let subtask_id = state.current_subtask.clone().unwrap_or_default();

                // Mark subtask as completed
                if let Some(plan) = state.plan.as_mut() {
                    if let Some(st) = plan.subtasks.iter_mut().find(|s| s.id == subtask_id) {
                        st.status = SubtaskStatus::Completed;
                        tracing::info!("Subtask completed: {} — {}", st.id, st.title);
                    }
                }

                // Save to store
                if let Some(ref plan) = state.plan {
                    let _ = store.save_plan(plan);
                }

                // Check if more subtasks remain
                let has_pending = state.plan.as_ref().map_or(false, |plan| {
                    plan.subtasks.iter().any(|s| s.status == SubtaskStatus::Pending)
                });

                if has_pending {
                    state.current_subtask = None;
                    state.retry_count = 0;
                    state.execution_result = None;
                    state.validation_result = None;
                    state.transition_to(OrchestratorPhase::SelectSubtask);
                } else {
                    state.transition_to(OrchestratorPhase::Done);
                }

                persist_state(&store, &mut state, &orch_state).await;
            }

            OrchestratorPhase::Replan => {
                tracing::info!("Replanning...");

                let subtask_id = state.current_subtask.clone().unwrap_or_default();
                let (subtask, validation_result) = {
                    let plan = state.plan.as_ref();
                    let st = plan.and_then(|p| p.subtasks.iter().find(|s| s.id == subtask_id).cloned());
                    let vr = state.validation_result.clone();
                    (st, vr)
                };

                let subtask = match subtask {
                    Some(s) => s,
                    None => {
                        state.log_error("No subtask context for replanning");
                        state.transition_to(OrchestratorPhase::Blocked);
                        persist_state(&store, &mut state, &orch_state).await;
                        continue;
                    }
                };

                let plan = state.plan.clone().unwrap_or_else(|| Plan {
                    task_id: state.task.id.clone(),
                    goal: state.task.user_request.clone(),
                    subtasks: vec![],
                    ..Default::default()
                });

                let repo_summary = context::build_repo_tree_summary(repo_path);
                let planning_context = PlanningContext {
                    user_goal: state.task.user_request.clone(),
                    repo_tree_summary: repo_summary,
                    previous_failures: state.error_log.clone(),
                    ..Default::default()
                };

                let val_result = validation_result.unwrap_or_else(|| ValidationResult {
                    subtask_id: subtask_id.clone(),
                    status: ValidationStatus::Fail,
                    commands_run: vec![],
                    errors: state.error_log.clone(),
                    notes: vec![],
                });

                match planner::replan(
                    &plan,
                    &subtask,
                    &val_result,
                    &planning_context,
                    &config,
                    &app_state,
                )
                .await
                {
                    Ok(replan_req) => {
                        // Apply the replan: replace the failed subtask
                        if let Some(plan) = state.plan.as_mut() {
                            if let Some(st) = plan.subtasks.iter_mut().find(|s| s.id == subtask_id) {
                                // Reset the failed subtask with revised instructions.
                                // Keep the original id — changing it would break `depends_on`
                                // references in sibling subtasks (dependencies_met looks up by id).
                                st.title = replan_req.revised_subtask.title;
                                st.allowed_files = replan_req.revised_subtask.allowed_files;
                                st.constraints = replan_req.revised_subtask.constraints;
                                st.test_commands = replan_req.revised_subtask.test_commands;
                                st.acceptance_criteria = replan_req.revised_subtask.acceptance_criteria;
                                st.status = SubtaskStatus::Pending;
                                st.retry_count = 0;
                            }
                        }
                        state.retry_count = 0;
                        state.execution_result = None;
                        state.validation_result = None;
                        state.current_subtask = None;
                        state.transition_to(OrchestratorPhase::SelectSubtask);
                    }
                    Err(e) => {
                        state.log_error(format!("Replan failed: {e}"));
                        state.transition_to(OrchestratorPhase::Blocked);
                        state.log_error("Replan failed. Provide manual guidance or cancel.");
                    }
                }

                persist_state(&store, &mut state, &orch_state).await;
            }

            OrchestratorPhase::Done => {
                state.task.status = TaskStatus::Done;
                state.task.completed_at = Some(chrono::Utc::now());
                let _ = store.save_task(&state.task);

                tracing::info!(
                    "Task {} completed: {}",
                    state.task.id,
                    state.task.user_request
                );

                persist_state(&store, &mut state, &orch_state).await;
                return Ok(());
            }

            OrchestratorPhase::Blocked => {
                state.task.status = TaskStatus::Blocked;
                tracing::warn!(
                    "Task {} blocked: {}",
                    state.task.id,
                    state.error_log.last().unwrap_or(&"Unknown reason".into())
                );

                persist_state(&store, &mut state, &orch_state).await;
                return Ok(());
            }
        }
    }
}

/// Continue a blocked task (called when user provides manual input).
pub async fn continue_blocked_task(
    task_id: &str,
    user_input: &str,
    orch_state: &SharedOrchState,
) -> Result<(), OrchestratorError> {
    let mut orch = orch_state.write().await;
    let state = orch
        .tasks
        .get_mut(task_id)
        .ok_or_else(|| OrchestratorError::TaskNotFound(task_id.into()))?;

    if state.phase != OrchestratorPhase::Blocked {
        return Err(OrchestratorError::Other(format!(
            "Task {task_id} is not in Blocked state (current: {:?})",
            state.phase
        )));
    }

    // Incorporate user guidance and go back to planning
    state.log_error(format!("User guidance: {user_input}"));
    state.retry_count = 0;
    state.task.status = TaskStatus::Planning;
    state.transition_to(OrchestratorPhase::Plan);

    Ok(())
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Generate a single-step plan for simple (non-planned) tasks.
fn make_single_step_plan(task: &Task, _context: &PlanningContext) -> Plan {
    Plan {
        task_id: task.id.clone(),
        goal: task.user_request.clone(),
        assumptions: vec![],
        subtasks: vec![Subtask {
            id: "task-1".to_string(),
            title: "Execute user request".to_string(),
            description: task.user_request.clone(),
            allowed_files: vec![], // no restrictions for direct mode
            suggested_context_files: vec![],
            constraints: vec![],
            test_commands: vec![],
            acceptance_criteria: vec![],
            depends_on: vec![],
            retry_count: 0,
            status: SubtaskStatus::Pending,
        }],
        global_constraints: vec![],
        completion_definition: vec![],
    }
}

/// Persist orchestrator state to both the shared state and SQLite.
async fn persist_state(
    store: &OrchestratorStore,
    state: &mut OrchState,
    shared: &SharedOrchState,
) {
    // Update shared state
    {
        let mut orch = shared.write().await;
        orch.tasks.insert(state.task.id.clone(), state.clone());
    }

    // Persist to SQLite (non-fatal on error)
    if let Err(e) = store.save_task(&state.task) {
        tracing::warn!("Failed to persist task: {e}");
    }
    if let Err(e) = store.save_orch_state(state) {
        tracing::warn!("Failed to persist orchestrator state: {e}");
    }
    if let Some(ref plan) = state.plan {
        if let Err(e) = store.save_plan(plan) {
            tracing::warn!("Failed to persist plan: {e}");
        }
    }
}
