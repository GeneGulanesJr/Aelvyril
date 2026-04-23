use std::path::Path;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use rusqlite::{params, Connection};

use super::types::{
    ExecutionResult, OrchState, OrchestratorPhase, Plan, Subtask, Task, TaskMode,
    TaskStatus, ValidationResult,
};

/// Persistent state store for the orchestrator, backed by SQLite.
///
/// Uses `Arc<parking_lot::Mutex<Connection>>` matching the existing codebase pattern
/// (see `token_usage::store`). All methods return `Result<T, String>`.
pub struct OrchestratorStore {
    conn: Arc<Mutex<Connection>>,
}

impl Clone for OrchestratorStore {
    fn clone(&self) -> Self {
        Self {
            conn: Arc::clone(&self.conn),
        }
    }
}

impl OrchestratorStore {
    /// Open (or create) the orchestrator database at the given path.
    ///
    /// Prefer `open_default()` for the standard location under the app data dir.
    pub fn open(db_path: &Path) -> Result<Self, String> {
        // Ensure parent directory exists.
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create orchestrator DB directory: {}", e))?;
        }

        let conn = Connection::open(db_path)
            .map_err(|e| format!("Failed to open orchestrator DB: {}", e))?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS tasks (
                id            TEXT PRIMARY KEY,
                user_request  TEXT NOT NULL,
                mode          TEXT NOT NULL,
                status        TEXT NOT NULL,
                created_at    TEXT NOT NULL,
                completed_at  TEXT
            );

            CREATE TABLE IF NOT EXISTS plans (
                task_id              TEXT PRIMARY KEY,
                goal                 TEXT NOT NULL,
                assumptions          TEXT NOT NULL DEFAULT '[]',
                global_constraints   TEXT NOT NULL DEFAULT '[]',
                completion_definition TEXT NOT NULL DEFAULT '[]'
            );

            CREATE TABLE IF NOT EXISTS subtasks (
                id                       TEXT PRIMARY KEY,
                plan_task_id             TEXT NOT NULL,
                title                    TEXT NOT NULL,
                description              TEXT NOT NULL,
                allowed_files             TEXT NOT NULL DEFAULT '[]',
                suggested_context_files  TEXT NOT NULL DEFAULT '[]',
                constraints              TEXT NOT NULL DEFAULT '[]',
                test_commands            TEXT NOT NULL DEFAULT '[]',
                acceptance_criteria      TEXT NOT NULL DEFAULT '[]',
                depends_on               TEXT NOT NULL DEFAULT '[]',
                retry_count              INTEGER NOT NULL DEFAULT 0,
                status                   TEXT NOT NULL,
                FOREIGN KEY(plan_task_id) REFERENCES plans(task_id)
            );

            CREATE TABLE IF NOT EXISTS execution_results (
                subtask_id          TEXT PRIMARY KEY,
                pi_completed        INTEGER NOT NULL DEFAULT 0,
                files_touched       TEXT NOT NULL DEFAULT '[]',
                files_outside_scope TEXT NOT NULL DEFAULT '[]',
                pi_summary          TEXT NOT NULL DEFAULT '',
                tool_calls_made     INTEGER NOT NULL DEFAULT 0,
                turns_taken         INTEGER NOT NULL DEFAULT 0,
                needs_replan        INTEGER NOT NULL DEFAULT 0,
                replan_reason       TEXT
            );

            CREATE TABLE IF NOT EXISTS validation_results (
                subtask_id   TEXT PRIMARY KEY,
                status       TEXT NOT NULL,
                commands_run TEXT NOT NULL DEFAULT '[]',
                errors       TEXT NOT NULL DEFAULT '[]',
                notes        TEXT NOT NULL DEFAULT '[]'
            );

            CREATE TABLE IF NOT EXISTS orch_state (
                task_id          TEXT PRIMARY KEY,
                phase            TEXT NOT NULL,
                current_subtask  TEXT,
                retry_count      INTEGER NOT NULL DEFAULT 0,
                error_log        TEXT NOT NULL DEFAULT '[]'
            );

            CREATE INDEX IF NOT EXISTS idx_subtasks_plan ON subtasks(plan_task_id);
            CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
            CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);",
        )
        .map_err(|e| format!("Failed to create orchestrator schema: {}", e))?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Open the store at the default path: `<data_local_dir>/aelvyril/orchestrator.db`.
    pub fn open_default() -> Result<Self, String> {
        let base = dirs::data_local_dir().ok_or_else(|| "Cannot determine local data directory".to_string())?;
        let db_path = base.join("aelvyril").join("orchestrator.db");
        Self::open(&db_path)
    }

    // ── Task CRUD ────────────────────────────────────────────────────────────

    /// Persist a task. Uses `INSERT OR REPLACE` so it doubles as upsert.
    pub fn save_task(&self, task: &Task) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO tasks (id, user_request, mode, status, created_at, completed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                task.id,
                task.user_request,
                serde_json::to_string(&task.mode).map_err(|e| format!("Failed to serialize task mode: {}", e))?,
                serde_json::to_string(&task.status).map_err(|e| format!("Failed to serialize task status: {}", e))?,
                task.created_at.to_rfc3339(),
                task.completed_at.map(|dt| dt.to_rfc3339()),
            ],
        )
        .map_err(|e| format!("Failed to save task: {}", e))?;
        Ok(())
    }

    /// Retrieve a single task by ID.
    pub fn get_task(&self, id: &str) -> Result<Option<Task>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, user_request, mode, status, created_at, completed_at FROM tasks WHERE id = ?1")
            .map_err(|e| format!("Failed to prepare task query: {}", e))?;

        let mut rows = stmt
            .query_map(params![id], |row| {
                let id: String = row.get(0)?;
                let user_request: String = row.get(1)?;
                let mode_str: String = row.get(2)?;
                let status_str: String = row.get(3)?;
                let created_at_str: String = row.get(4)?;
                let completed_at_str: Option<String> = row.get(5)?;

                Ok((id, user_request, mode_str, status_str, created_at_str, completed_at_str))
            })
            .map_err(|e| format!("Failed to query task: {}", e))?;

        match rows.next() {
            Some(row) => {
                let (id, user_request, mode_str, status_str, created_at_str, completed_at_str) =
                    row.map_err(|e| format!("Failed to read task row: {}", e))?;

                let mode: TaskMode =
                    serde_json::from_str(&mode_str).map_err(|e| format!("Failed to deserialize task mode: {}", e))?;
                let status: TaskStatus =
                    serde_json::from_str(&status_str).map_err(|e| format!("Failed to deserialize task status: {}", e))?;
                let created_at: DateTime<Utc> = DateTime::parse_from_rfc3339(&created_at_str)
                    .map(|dt| dt.to_utc())
                    .map_err(|e| format!("Failed to parse created_at: {}", e))?;
                let completed_at: Option<DateTime<Utc>> = completed_at_str
                    .map(|s| {
                        DateTime::parse_from_rfc3339(&s)
                            .map(|dt| dt.to_utc())
                            .map_err(|e| format!("Failed to parse completed_at: {}", e))
                    })
                    .transpose()?;

                Ok(Some(Task {
                    id,
                    user_request,
                    mode,
                    status,
                    created_at,
                    completed_at,
                }))
            }
            None => Ok(None),
        }
    }

    /// List all tasks, ordered by creation time (newest first).
    pub fn list_tasks(&self) -> Result<Vec<Task>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, user_request, mode, status, created_at, completed_at FROM tasks ORDER BY created_at DESC")
            .map_err(|e| format!("Failed to prepare list_tasks query: {}", e))?;

        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let user_request: String = row.get(1)?;
                let mode_str: String = row.get(2)?;
                let status_str: String = row.get(3)?;
                let created_at_str: String = row.get(4)?;
                let completed_at_str: Option<String> = row.get(5)?;
                Ok((id, user_request, mode_str, status_str, created_at_str, completed_at_str))
            })
            .map_err(|e| format!("Failed to query tasks: {}", e))?;

        let mut tasks = Vec::new();
        for row in rows {
            let (id, user_request, mode_str, status_str, created_at_str, completed_at_str) =
                row.map_err(|e| format!("Failed to read task row: {}", e))?;

            let mode: TaskMode =
                    serde_json::from_str(&mode_str).map_err(|e| format!("Failed to deserialize task mode: {}", e))?;
            let status: TaskStatus =
                serde_json::from_str(&status_str).map_err(|e| format!("Failed to deserialize task status: {}", e))?;
            let created_at: DateTime<Utc> = DateTime::parse_from_rfc3339(&created_at_str)
                .map(|dt| dt.to_utc())
                .map_err(|e| format!("Failed to parse created_at: {}", e))?;
            let completed_at: Option<DateTime<Utc>> = completed_at_str
                .map(|s| {
                    DateTime::parse_from_rfc3339(&s)
                        .map(|dt| dt.to_utc())
                        .map_err(|e| format!("Failed to parse completed_at: {}", e))
                })
                .transpose()?;

            tasks.push(Task {
                id,
                user_request,
                mode,
                status,
                created_at,
                completed_at,
            });
        }
        Ok(tasks)
    }

    // ── Plan CRUD ────────────────────────────────────────────────────────────

    /// Persist a plan (1:1 with its parent task). Uses `INSERT OR REPLACE`.
    pub fn save_plan(&self, plan: &Plan) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO plans (task_id, goal, assumptions, global_constraints, completion_definition)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                plan.task_id,
                plan.goal,
                serde_json::to_string(&plan.assumptions).map_err(|e| format!("Failed to serialize plan assumptions: {}", e))?,
                serde_json::to_string(&plan.global_constraints).map_err(|e| format!("Failed to serialize global_constraints: {}", e))?,
                serde_json::to_string(&plan.completion_definition).map_err(|e| format!("Failed to serialize completion_definition: {}", e))?,
            ],
        )
        .map_err(|e| format!("Failed to save plan: {}", e))?;

        // Upsert all subtasks belonging to this plan.
        for subtask in &plan.subtasks {
            self.save_subtask_locked(&conn, subtask, &plan.task_id)?;
        }

        Ok(())
    }

    /// Retrieve a plan by its task_id. Returns `None` if no plan row exists.
    /// Does NOT load subtasks — use `get_subtasks(plan.task_id)` separately.
    pub fn get_plan(&self, task_id: &str) -> Result<Option<Plan>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT task_id, goal, assumptions, global_constraints, completion_definition FROM plans WHERE task_id = ?1")
            .map_err(|e| format!("Failed to prepare plan query: {}", e))?;

        let mut rows = stmt
            .query_map(params![task_id], |row| {
                let task_id: String = row.get(0)?;
                let goal: String = row.get(1)?;
                let assumptions_str: String = row.get(2)?;
                let global_constraints_str: String = row.get(3)?;
                let completion_definition_str: String = row.get(4)?;
                Ok((task_id, goal, assumptions_str, global_constraints_str, completion_definition_str))
            })
            .map_err(|e| format!("Failed to query plan: {}", e))?;

        match rows.next() {
            Some(row) => {
                let (task_id, goal, assumptions_str, global_constraints_str, completion_definition_str) =
                    row.map_err(|e| format!("Failed to read plan row: {}", e))?;

                let assumptions: Vec<String> = serde_json::from_str(&assumptions_str)
                    .map_err(|e| format!("Failed to deserialize plan assumptions: {}", e))?;
                let global_constraints: Vec<String> = serde_json::from_str(&global_constraints_str)
                    .map_err(|e| format!("Failed to deserialize global_constraints: {}", e))?;
                let completion_definition: Vec<String> = serde_json::from_str(&completion_definition_str)
                    .map_err(|e| format!("Failed to deserialize completion_definition: {}", e))?;

                Ok(Some(Plan {
                    task_id,
                    goal,
                    assumptions,
                    subtasks: Vec::new(), // loaded separately
                    global_constraints,
                    completion_definition,
                }))
            }
            None => Ok(None),
        }
    }

    // ── Subtask CRUD ─────────────────────────────────────────────────────────

    /// Internal: save a subtask when we already hold the lock.
    /// Note: `plan_task_id` is passed separately since `Subtask` doesn't carry it.
    fn save_subtask_locked(&self, conn: &Connection, subtask: &Subtask, plan_task_id: &str) -> Result<(), String> {
        conn.execute(
            "INSERT OR REPLACE INTO subtasks (
                id, plan_task_id, title, description,
                allowed_files, suggested_context_files, constraints,
                test_commands, acceptance_criteria, depends_on,
                retry_count, status
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                subtask.id,
                plan_task_id,
                subtask.title,
                subtask.description,
                serde_json::to_string(&subtask.allowed_files).map_err(|e| format!("Failed to serialize allowed_files: {}", e))?,
                serde_json::to_string(&subtask.suggested_context_files).map_err(|e| format!("Failed to serialize suggested_context_files: {}", e))?,
                serde_json::to_string(&subtask.constraints).map_err(|e| format!("Failed to serialize constraints: {}", e))?,
                serde_json::to_string(&subtask.test_commands).map_err(|e| format!("Failed to serialize test_commands: {}", e))?,
                serde_json::to_string(&subtask.acceptance_criteria).map_err(|e| format!("Failed to serialize acceptance_criteria: {}", e))?,
                serde_json::to_string(&subtask.depends_on).map_err(|e| format!("Failed to serialize depends_on: {}", e))?,
                subtask.retry_count,
                serde_json::to_string(&subtask.status).map_err(|e| format!("Failed to serialize subtask status: {}", e))?,
            ],
        )
        .map_err(|e| format!("Failed to save subtask: {}", e))?;
        Ok(())
    }

    /// Retrieve all subtasks for a given plan (identified by plan_task_id).
    pub fn get_subtasks(&self, plan_task_id: &str) -> Result<Vec<Subtask>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, plan_task_id, title, description,
                        allowed_files, suggested_context_files, constraints,
                        test_commands, acceptance_criteria, depends_on,
                        retry_count, status
                 FROM subtasks WHERE plan_task_id = ?1",
            )
            .map_err(|e| format!("Failed to prepare subtasks query: {}", e))?;

        let rows = stmt
            .query_map(params![plan_task_id], |row| {
                let id: String = row.get(0)?;
                let _plan_task_id: String = row.get(1)?;
                let title: String = row.get(2)?;
                let description: String = row.get(3)?;
                let allowed_files_str: String = row.get(4)?;
                let suggested_context_files_str: String = row.get(5)?;
                let constraints_str: String = row.get(6)?;
                let test_commands_str: String = row.get(7)?;
                let acceptance_criteria_str: String = row.get(8)?;
                let depends_on_str: String = row.get(9)?;
                let retry_count: i32 = row.get(10)?;
                let status_str: String = row.get(11)?;

                Ok((
                    id, title, description,
                    allowed_files_str, suggested_context_files_str, constraints_str,
                    test_commands_str, acceptance_criteria_str, depends_on_str,
                    retry_count, status_str,
                ))
            })
            .map_err(|e| format!("Failed to query subtasks: {}", e))?;

        let mut subtasks = Vec::new();
        for row in rows {
            let (id, title, description, allowed_files_str, suggested_context_files_str, constraints_str, test_commands_str, acceptance_criteria_str, depends_on_str, retry_count, status_str) =
                row.map_err(|e| format!("Failed to read subtask row: {}", e))?;

            subtasks.push(Subtask {
                id,
                title,
                description,
                allowed_files: serde_json::from_str(&allowed_files_str).unwrap_or_default(),
                suggested_context_files: serde_json::from_str(&suggested_context_files_str).unwrap_or_default(),
                constraints: serde_json::from_str(&constraints_str).unwrap_or_default(),
                test_commands: serde_json::from_str(&test_commands_str).unwrap_or_default(),
                acceptance_criteria: serde_json::from_str(&acceptance_criteria_str).unwrap_or_default(),
                depends_on: serde_json::from_str(&depends_on_str).unwrap_or_default(),
                retry_count: retry_count as u8,
                status: serde_json::from_str(&status_str).map_err(|e| format!("Failed to deserialize subtask status: {}", e))?,
            });
        }
        Ok(subtasks)
    }

    // ── Execution Result ────────────────────────────────────────────────────

    /// Persist an execution result. Uses `INSERT OR REPLACE`.
    pub fn save_execution_result(&self, result: &ExecutionResult) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO execution_results (
                subtask_id, pi_completed, files_touched, files_outside_scope,
                pi_summary, tool_calls_made, turns_taken, needs_replan, replan_reason
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                result.subtask_id,
                result.pi_completed as i32,
                serde_json::to_string(&result.files_touched).map_err(|e| format!("Failed to serialize files_touched: {}", e))?,
                serde_json::to_string(&result.files_outside_scope).map_err(|e| format!("Failed to serialize files_outside_scope: {}", e))?,
                result.pi_summary,
                result.tool_calls_made,
                result.turns_taken,
                result.needs_replan as i32,
                result.replan_reason,
            ],
        )
        .map_err(|e| format!("Failed to save execution result: {}", e))?;
        Ok(())
    }

    // ── Validation Result ───────────────────────────────────────────────────

    /// Persist a validation result. Uses `INSERT OR REPLACE`.
    pub fn save_validation_result(&self, result: &ValidationResult) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO validation_results (
                subtask_id, status, commands_run, errors, notes
            ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                result.subtask_id,
                serde_json::to_string(&result.status).map_err(|e| format!("Failed to serialize validation status: {}", e))?,
                serde_json::to_string(&result.commands_run).map_err(|e| format!("Failed to serialize commands_run: {}", e))?,
                serde_json::to_string(&result.errors).map_err(|e| format!("Failed to serialize errors: {}", e))?,
                serde_json::to_string(&result.notes).map_err(|e| format!("Failed to serialize notes: {}", e))?,
            ],
        )
        .map_err(|e| format!("Failed to save validation result: {}", e))?;
        Ok(())
    }

    // ── Orchestrator State ────────────────────────────────────────────────────

    /// Persist orchestrator state (phase, current subtask, etc.). Uses `INSERT OR REPLACE`.
    pub fn save_orch_state(&self, state: &OrchState) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO orch_state (task_id, phase, current_subtask, retry_count, error_log)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                state.task.id,
                serde_json::to_string(&state.phase).map_err(|e| format!("Failed to serialize orch phase: {}", e))?,
                state.current_subtask,
                state.retry_count,
                serde_json::to_string(&state.error_log).map_err(|e| format!("Failed to serialize error_log: {}", e))?,
            ],
        )
        .map_err(|e| format!("Failed to save orch state: {}", e))?;
        Ok(())
    }

    /// Retrieve orchestrator state for a task. Returns `None` if no state row exists.
    ///
    /// Note: The returned `OrchState` will have `plan: None`. The caller should
    /// load the plan + subtasks separately via `get_plan` / `get_subtasks`.
    pub fn get_orch_state(&self, task_id: &str) -> Result<Option<OrchState>, String> {
        let conn = self.conn.lock();

        // First, get the task itself.
        let task = match self.get_task(task_id)? {
            Some(t) => t,
            None => return Ok(None),
        };

        // Then get the state row.
        let mut stmt = conn
            .prepare("SELECT task_id, phase, current_subtask, retry_count, error_log FROM orch_state WHERE task_id = ?1")
            .map_err(|e| format!("Failed to prepare orch_state query: {}", e))?;

        let mut rows = stmt
            .query_map(params![task_id], |row| {
                let task_id: String = row.get(0)?;
                let phase_str: String = row.get(1)?;
                let current_subtask: Option<String> = row.get(2)?;
                let retry_count: i32 = row.get(3)?;
                let error_log_str: String = row.get(4)?;
                Ok((task_id, phase_str, current_subtask, retry_count, error_log_str))
            })
            .map_err(|e| format!("Failed to query orch_state: {}", e))?;

        match rows.next() {
            Some(row) => {
                let (_task_id, phase_str, current_subtask, retry_count, error_log_str) =
                    row.map_err(|e| format!("Failed to read orch_state row: {}", e))?;

                let phase: OrchestratorPhase =
                    serde_json::from_str(&phase_str).map_err(|e| format!("Failed to deserialize orch phase: {}", e))?;
                let error_log: Vec<String> = serde_json::from_str(&error_log_str).unwrap_or_default();

                Ok(Some(OrchState {
                    task,
                    plan: None, // caller loads plan separately
                    current_subtask,
                    phase,
                    retry_count: retry_count as u8,
                    validation_retry_count: 0, // loaded separately if needed
                    error_log,
                    execution_result: None,
                    validation_result: None,
                    cancelled: false,
                    cancel_tx: None,
                }))
            }
            None => Ok(None),
        }
    }
}