use thiserror::Error;

/// All errors that can arise from orchestrator operations.
///
/// Integrates with the existing codebase pattern: Tauri commands convert
/// these to `String` via `.map_err(|e| e.to_string())?`.
#[derive(Debug, Error)]
pub enum OrchestratorError {
    // ── Pre-flight / Configuration ──────────────────────────────────────────
    #[error("Gateway is not running")]
    GatewayNotRunning,

    #[error("No upstream providers configured")]
    NoProviders,

    #[error("Planning model not configured")]
    PlanningModelNotConfigured,

    #[error("Executor model not configured")]
    ExecutorModelNotConfigured,

    #[error("No provider configured for planning model: {0}")]
    NoProviderForPlanningModel(String),

    #[error("No provider configured for executor model: {0}")]
    NoProviderForExecutorModel(String),

    #[error("pi is not installed — install with: npm install -g @mariozechner/pi-coding-agent")]
    PiNotInstalled,

    #[error("pi configuration error: {0}")]
    PiConfigError(String),

    #[error("No gateway API key available")]
    NoGatewayKey,

    // ── Planning ────────────────────────────────────────────────────────────
    #[error("Planning model returned invalid JSON: {0}")]
    InvalidPlanJson(String),

    #[error("Plan schema validation failed: {0}")]
    PlanSchemaValidation(String),

    #[error("Planning model call failed: {0}")]
    PlanningModelFailed(String),

    #[error("Replan failed: {0}")]
    ReplanFailed(String),

    // ── Execution ──────────────────────────────────────────────────────────
    #[error("Executor timed out after {0}s")]
    ExecutorTimeout(u64),

    #[error("Executor exceeded tool call limit ({0})")]
    ToolCallLimit(u32),

    #[error("Executor process crashed: {0}")]
    ExecutorCrashed(String),

    #[error("Executor touched files outside allowed scope: {0}")]
    ScopeViolation(String),

    #[error("Executor produced no output (no tool calls, no files changed)")]
    EmptyExecution,

    #[error("No executable subtask available (dependencies not met)")]
    NoExecutableSubtask,

    // ── Validation ──────────────────────────────────────────────────────────
    #[error("Validation failed: {0}")]
    ValidationFailed(String),

    #[error("Forbidden test command: {0}")]
    ForbiddenTestCommand(String),

    #[error("Shell operators not allowed in test commands: {0}")]
    ShellOperatorsNotAllowed(String),

    // ── I/O and Infrastructure ──────────────────────────────────────────────
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    // ── General ─────────────────────────────────────────────────────────────
    #[error("Task not found: {0}")]
    TaskNotFound(String),

    #[error("Task already in progress: {0}")]
    TaskInProgress(String),

    #[error("Orchestrator is disabled — enable it in settings first")]
    OrchestratorDisabled,

    #[error("{0}")]
    Other(String),
}

impl From<String> for OrchestratorError {
    fn from(s: String) -> Self {
        OrchestratorError::Other(s)
    }
}