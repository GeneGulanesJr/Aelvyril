use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ── Phase Enum ──────────────────────────────────────────────────────────────

/// Orchestrator state machine phases.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum OrchestratorPhase {
    Intake,
    Plan,
    ParsePlan,
    SelectSubtask,
    Execute,
    ParseExecution,
    Validate,
    CompleteSubtask,
    Replan,
    Done,
    Blocked,
}

// ── Task Mode ───────────────────────────────────────────────────────────────

/// How the orchestrator handles a task.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskMode {
    Planned,
    Direct,
}

// ── Task Status ─────────────────────────────────────────────────────────────

/// Status of a top-level task.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Intake,
    Planning,
    Executing,
    Blocked,
    Done,
    Cancelled,
}

// ── Subtask Status ──────────────────────────────────────────────────────────

/// Status of a subtask within a plan.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SubtaskStatus {
    Pending,
    Executing,
    Completed,
    Failed,
    Blocked,
}

// ── Validation Status ───────────────────────────────────────────────────────

/// Result of running test commands for a subtask.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ValidationStatus {
    Pass,
    Fail,
}

// ── Core Data Types ─────────────────────────────────────────────────────────

/// A top-level orchestrator task created from a user request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub user_request: String,
    pub mode: TaskMode,
    pub status: TaskStatus,
    #[serde(with = "chrono::serde::ts_seconds")]
    pub created_at: DateTime<Utc>,
    #[serde(default, with = "chrono::serde::ts_seconds_option")]
    pub completed_at: Option<DateTime<Utc>>,
}

impl Task {
    pub fn new(user_request: String, mode: TaskMode) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            user_request,
            mode,
            status: TaskStatus::Intake,
            created_at: Utc::now(),
            completed_at: None,
        }
    }
}

/// A plan produced by the planning model, containing subtasks.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Plan {
    pub task_id: String,
    pub goal: String,
    #[serde(default)]
    pub assumptions: Vec<String>,
    pub subtasks: Vec<Subtask>,
    #[serde(default)]
    pub global_constraints: Vec<String>,
    #[serde(default)]
    pub completion_definition: Vec<String>,
}

/// A single step within a plan, executed by pi.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Subtask {
    pub id: String,
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub allowed_files: Vec<String>,
    #[serde(default)]
    pub suggested_context_files: Vec<String>,
    #[serde(default)]
    pub constraints: Vec<String>,
    #[serde(default)]
    pub test_commands: Vec<String>,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub retry_count: u8,
    pub status: SubtaskStatus,
}

impl Subtask {
    /// Check whether this subtask's dependencies are all in `Completed` status.
    pub fn dependencies_met(&self, subtasks: &[Subtask]) -> bool {
        self.depends_on.iter().all(|dep_id| {
            subtasks
                .iter()
                .find(|s| s.id == *dep_id)
                .map_or(false, |s| s.status == SubtaskStatus::Completed)
        })
    }
}

/// Result of executing a subtask via the pi RPC executor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionResult {
    pub subtask_id: String,
    pub pi_completed: bool,
    #[serde(default)]
    pub files_touched: Vec<String>,
    #[serde(default)]
    pub files_outside_scope: Vec<String>,
    #[serde(default)]
    pub pi_summary: String,
    #[serde(default)]
    pub tool_calls_made: u32,
    #[serde(default)]
    pub turns_taken: u32,
    #[serde(default)]
    pub needs_replan: bool,
    #[serde(default)]
    pub replan_reason: Option<String>,
    /// Whether a git diff audit was performed to catch bash-made file changes.
    #[serde(default)]
    pub git_diff_applied: bool,
}

/// Result of running validation commands for a subtask.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationResult {
    pub subtask_id: String,
    pub status: ValidationStatus,
    #[serde(default)]
    pub commands_run: Vec<String>,
    #[serde(default)]
    pub errors: Vec<String>,
    #[serde(default)]
    pub notes: Vec<String>,
}

/// Replan request produced when a subtask fails validation or scope checks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplanRequest {
    pub reason: String,
    pub failed_subtask_id: String,
    #[serde(default)]
    pub failure_summary: Vec<String>,
    pub revised_subtask: RevisedSubtask,
}

/// A revised subtask produced by replanning.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RevisedSubtask {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub allowed_files: Vec<String>,
    #[serde(default)]
    pub constraints: Vec<String>,
    #[serde(default)]
    pub test_commands: Vec<String>,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
}

// ── Orchestrator State ───────────────────────────────────────────────────────

/// Full orchestrator state for a single task — the state machine's working memory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchState {
    pub task: Task,
    pub plan: Option<Plan>,
    pub current_subtask: Option<String>,
    pub phase: OrchestratorPhase,
    #[serde(default)]
    pub retry_count: u8,
    /// Separate retry counter for validation failures. The state machine
    /// uses `validation_retry_count` when looping back from Validate→Execute,
    /// keeping `retry_count` reserved for execution failures only. This
    /// prevents the two retry loops from consuming each other's budget.
    #[serde(default)]
    pub validation_retry_count: u8,
    #[serde(default)]
    pub error_log: Vec<String>,
    /// Runtime-only: result from the last execution (not persisted to SQLite separately by state).
    #[serde(skip)]
    pub execution_result: Option<ExecutionResult>,
    /// Runtime-only: result from the last validation.
    #[serde(skip)]
    pub validation_result: Option<ValidationResult>,
    /// Runtime-only: set to true by `cancel_orchestrator_task` to signal
    /// the background loop to stop after the current phase completes.
    #[serde(skip)]
    pub cancelled: bool,
    /// Runtime-only: watch sender for immediate cancellation signalling.
    /// When `cancel_orchestrator_task` fires, it sends `true` on this channel
    /// so the pi executor can kill the subprocess without waiting for a timeout.
    #[serde(skip)]
    pub cancel_tx: Option<tokio::sync::watch::Sender<bool>>,
}

impl OrchState {
    pub fn new(task: Task) -> Self {
        Self {
            task,
            plan: None,
            current_subtask: None,
            phase: OrchestratorPhase::Intake,
            retry_count: 0,
            validation_retry_count: 0,
            error_log: Vec::new(),
            execution_result: None,
            validation_result: None,
            cancelled: false,
            cancel_tx: None,
        }
    }

    /// Convenience: transition to a new phase and log it.
    pub fn transition_to(&mut self, phase: OrchestratorPhase) {
        tracing::debug!(
            "Orchestrator phase: {:?} → {:?} (task={})",
            self.phase,
            phase,
            self.task.id,
        );
        self.phase = phase;
    }

    /// Log an error message to the state's error log.
    /// Capped at 50 entries — oldest entries are dropped when exceeded.
    pub fn log_error(&mut self, msg: impl Into<String>) {
        self.error_log.push(msg.into());
        while self.error_log.len() > 50 {
            self.error_log.remove(0);
        }
    }
}

// ── Settings ────────────────────────────────────────────────────────────────

/// Orchestrator configuration. Stored as part of `AppSettings` with `#[serde(default)]`
/// so existing config files gracefully fill in defaults.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct OrchestratorSettings {
    /// Whether the orchestrator is enabled.
    pub enabled: bool,
    /// Model name for planning (routes through Aelvyril gateway).
    pub planning_model: String,
    /// Model name for execution via pi.
    pub executor_model: String,
    /// Maximum executor retries per subtask before replanning.
    pub max_subtask_retries: u8,
    /// Maximum number of files a subtask may modify.
    pub max_files_per_subtask: usize,
    /// Timeout for a single pi execution, in seconds.
    pub executor_timeout_secs: u64,
    /// Maximum number of tool calls pi may make per subtask.
    pub max_tool_calls: u32,
    /// Additional allowed test command prefixes beyond the built-in whitelist.
    pub allowed_test_commands: Vec<String>,
}

impl Default for OrchestratorSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            planning_model: String::new(),
            executor_model: String::new(),
            max_subtask_retries: 2,
            max_files_per_subtask: 6,
            executor_timeout_secs: 600,
            max_tool_calls: 30,
            allowed_test_commands: Vec::new(),
        }
    }
}

// ── Context Builders ─────────────────────────────────────────────────────────

/// Broad context provided to the planning model.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PlanningContext {
    pub user_goal: String,
    /// Condensed repo tree (generated by a lightweight Rust walk, NOT by spawning pi).
    #[serde(default)]
    pub repo_tree_summary: String,
    /// Key entry-point files.
    #[serde(default)]
    pub entry_points: Vec<String>,
    /// Relevant module paths.
    #[serde(default)]
    pub relevant_modules: Vec<String>,
    /// Current build/lint errors, if any.
    #[serde(default)]
    pub current_errors: Vec<String>,
    /// User-supplied constraints.
    #[serde(default)]
    pub user_constraints: Vec<String>,
    /// Summaries of previously failed attempts (for replanning).
    #[serde(default)]
    pub previous_failures: Vec<String>,
}

/// Narrow context provided to the executor for a single subtask.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutorContext {
    pub subtask_id: String,
    pub subtask_description: String,
    /// Files the executor is allowed to modify.
    #[serde(default)]
    pub allowed_files: Vec<String>,
    /// Constraints specific to this subtask.
    #[serde(default)]
    pub constraints: Vec<String>,
    /// Acceptance criteria for this subtask.
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    /// Previous errors, if retrying a failed subtask.
    #[serde(default)]
    pub previous_errors: Option<Vec<String>>,
    /// Path to the repository, used for git diff audit of bash-made changes.
    #[serde(default)]
    pub repo_path: Option<String>,
}

// ── Shared Orchestrator State (Tauri-managed) ────────────────────────────────

/// Top-level orchestrator state container, managed via `Arc<RwLock<...>>` in Tauri,
/// separate from `AppState` to avoid lock contention on long-running tasks.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OrchestratorState {
    /// Currently active task states, keyed by task ID.
    #[serde(default)]
    pub tasks: std::collections::HashMap<String, OrchState>,
}

impl OrchestratorState {
    pub fn new() -> Self {
        Self::default()
    }
}