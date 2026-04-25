# Orchestrator Frontend Implementation Plan

## Overview

The orchestrator backend is **fully implemented** in Rust (`src-tauri/src/orchestrator/`) with 8 Tauri commands exposed. The frontend has **zero UI**. This plan builds a complete production-ready frontend across 7 phases.

Each phase is self-contained: create the listed files, run the verification step, then move on.

> **All CSS variable names, class names, and command signatures in this plan have been verified against the actual codebase.** See Appendix A for the verified design system variable map.

---

## Architecture

```
src/
├── hooks/tauri/
│   ├── types.ts                          ← Phase 1: TS types + helpers
│   └── orchestrator.ts                   ← Phase 2: React hook
├── components/
│   ├── orchestrator/
│   │   ├── TaskList.tsx                  ← Phase 3: List component
│   │   ├── TaskList.module.css
│   │   ├── TaskDetail.tsx                ← Phase 4: Detail panel
│   │   ├── TaskDetail.module.css
│   │   ├── SubtaskList.tsx               ← Phase 3: Simple components
│   │   ├── SubtaskList.module.css
│   │   ├── NewTaskModal.tsx              ← Phase 3
│   │   └── NewTaskModal.module.css
│   ├── settings/
│   │   └── OrchestratorSection.tsx        ← Phase 6: Settings tab
│   └── Sidebar.tsx                       ← Phase 6: Modified
├── pages/
│   ├── Orchestrator.tsx                  ← Phase 5: Page component
│   └── Orchestrator.module.css
└── App.tsx                               ← Phase 6: Modified
```

**Data flow:** `OrchestratorPage` → `useOrchestrator` hook → `tauriInvoke()` → Rust commands → SQLite

**Available Tauri commands (verified against `src-tauri/src/commands/orchestrator.rs`):**
| Command | JS args | Returns |
|---------|---------|---------|
| `start_orchestrator_task` | `{ request }` | `string` (task_id) |
| `get_orchestrator_state` | `{ task_id }` | `OrchState` (raw JSON value) |
| `get_orchestrator_task_list` | `()` | `{ tasks: [TaskSummary] }` |
| `get_orchestrator_plan` | `{ task_id }` | **BUG** — see Phase 0 Fix 3 |
| `cancel_orchestrator_task` | `{ task_id }` | `void` |
| `respond_to_blocked` | `{ task_id, user_input }` | `OrchState` (raw JSON value) |
| `get_orchestrator_settings` | `()` | `OrchestratorSettings` |
| `update_orchestrator_settings` | `{ settings: OrchestratorSettings }` | `void` |

> **Note on `tauriInvoke` signature** (verified against `src/hooks/tauri/invoke.ts`):
> ```typescript
> export async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
> export function logInvokeError(component: string, message: string, e: unknown): void
> ```

---

## Phase 0: Backend Bug Fixes

> **Prerequisite.** These Rust-side bugs will cause frontend failures if not fixed first.

### Fix 1: Task List Casing Inconsistency

**Problem:** `get_orchestrator_task_list` uses `format!("{:?}", ...)` which produces PascalCase (`"Executing"`, `"ParsePlan"`), while `get_orchestrator_state` uses `serde_json::to_value()` which respects `#[serde(rename_all = "snake_case")]` and produces snake_case (`"executing"`, `"parse_plan"`). Same enum values serialize differently across endpoints.

**File:** `src-tauri/src/commands/orchestrator.rs`

Replace:
```rust
"status": format!("{:?}", s.task.status),
"phase": format!("{:?}", s.phase),
```

With:
```rust
"status": serde_json::to_value(&s.task.status).unwrap_or(serde_json::Value::Null),
"phase": serde_json::to_value(&s.phase).unwrap_or(serde_json::Value::Null),
```

### Fix 2: Expose Execution & Validation Results

**Problem:** `OrchState` marks `execution_result` and `validation_result` with `#[serde(skip)]`, so `get_orchestrator_state` never returns them. These are the most interesting data for the UI (what pi did, what tests passed).

**Chosen approach: Option A — add two new Tauri commands.** This avoids changing `#[serde(skip)]` on `cancel_tx` which would cause serialization errors.

**File:** `src-tauri/src/commands/orchestrator.rs` — Add two commands:

```rust
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
```

**File:** `src-tauri/src/commands/mod.rs` — Register the new commands in `invoke_handler()`:

Add these two lines to the `// ── Orchestrator ──` section of `tauri::generate_handler![]`:
```rust
get_execution_result,
get_validation_result,
```

### Fix 3: `get_orchestrator_plan` Inconsistent Return Shape

**Problem:** When plan is `Some`, the endpoint serializes the plan directly (returns the plan object at the top level). When plan is `None`, it returns `{ "plan": null }`. The frontend expects `{ plan: Plan | null }` in both cases, which only works for the `None` case.

**File:** `src-tauri/src/commands/orchestrator.rs`

Replace the entire `get_orchestrator_plan` function body with:
```rust
Ok(serde_json::json!({ "plan": state.plan }))
```

This makes both `Some` and `None` return a consistent `{ "plan": ... }` wrapper.

### Verification
- [x] Run `cargo build` — no compilation errors ✅ verified
- [x] Call `get_orchestrator_task_list` — status/phase fields are now snake_case ✅ verified
- [x] Call `get_orchestrator_plan` with a task that has a plan — returns `{ "plan": { ... } }` ✅ verified
- [x] Call `get_orchestrator_plan` with a task that has no plan — returns `{ "plan": null }` ✅ verified
- [x] Call `get_execution_result` — returns the execution result or null ✅ verified
- [x] Call `get_validation_result` — returns the validation result or null ✅ verified

---

## Phase 1: TypeScript Types & Helpers

**Goal:** Foundation types that all other phases depend on.

**File:** `src/hooks/tauri/types.ts` — **Append** the following to the existing file (after the existing `TokenStatsResponse` interface).

```typescript
// ── Orchestrator Types ────────────────────────────────────────────

export type OrchestratorPhase =
  | 'intake'
  | 'plan'
  | 'parse_plan'
  | 'select_subtask'
  | 'execute'
  | 'parse_execution'
  | 'validate'
  | 'complete_subtask'
  | 'replan'
  | 'done'
  | 'blocked';

export type TaskMode = 'planned' | 'direct';

export type TaskStatus =
  | 'intake'
  | 'planning'
  | 'executing'
  | 'blocked'
  | 'done'
  | 'cancelled';

export type SubtaskStatus =
  | 'pending'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'blocked';

export type ValidationStatus = 'pass' | 'fail';

export interface Task {
  id: string;
  user_request: string;
  mode: TaskMode;
  status: TaskStatus;
  created_at: number; // Unix epoch seconds (from chrono::serde::ts_seconds)
  completed_at: number | null;
}

export interface Subtask {
  id: string;
  title: string;
  description: string;
  allowed_files: string[];
  suggested_context_files: string[];
  constraints: string[];
  test_commands: string[];
  acceptance_criteria: string[];
  depends_on: string[];
  retry_count: number;
  status: SubtaskStatus;
}

export interface Plan {
  task_id: string;
  goal: string;
  assumptions: string[];
  subtasks: Subtask[];
  global_constraints: string[];
  completion_definition: string[];
}

export interface ExecutionResult {
  subtask_id: string;
  pi_completed: boolean;
  files_touched: string[];
  files_outside_scope: string[];
  pi_summary: string;
  tool_calls_made: number;
  turns_taken: number;
  needs_replan: boolean;
  replan_reason: string | null;
  git_diff_applied: boolean;
}

export interface ValidationResult {
  subtask_id: string;
  status: ValidationStatus;
  commands_run: string[];
  errors: string[];
  notes: string[];
}

export interface OrchestratorState {
  task: Task;
  plan: Plan | null;
  current_subtask: string | null;
  phase: OrchestratorPhase;
  retry_count: number;
  validation_retry_count: number;
  error_log: string[];
  // `cancelled` and `cancel_tx` are #[serde(skip)] in Rust — never serialized.
  // Derive cancelled status from task.status === 'cancelled' instead.
  // execution_result and validation_result are also #[serde(skip)].
  // Fetch them separately via get_execution_result / get_validation_result.
}

export interface OrchestratorSettings {
  enabled: boolean;
  planning_model: string;
  executor_model: string;
  max_subtask_retries: number;
  max_files_per_subtask: number;
  executor_timeout_secs: number;
  max_tool_calls: number;
  allowed_test_commands: string[];
}

// Matches Rust Default impl in types.rs. Single source of truth for the frontend.
export const DEFAULT_ORCHESTRATOR_SETTINGS: OrchestratorSettings = {
  enabled: false,
  planning_model: "",
  executor_model: "",
  max_subtask_retries: 2,
  max_files_per_subtask: 6,
  executor_timeout_secs: 600,
  max_tool_calls: 30,
  allowed_test_commands: [],
};

export interface TaskSummary {
  id: string;
  request: string;
  status: string;   // Raw from backend — normalize with normalizeStatus()
  phase: string;    // Raw from backend — normalize with normalizePhase()
  created_at: number; // Unix epoch seconds
  completed_at: number | null;
}

// ── Normalization Helpers ─────────────────────────────────────────
// Backend may return either PascalCase ("Executing") or snake_case ("executing")
// depending on endpoint. These helpers ensure consistent casing.

export function normalizeStatus(raw: string): TaskStatus {
  const lower = raw.toLowerCase();
  const valid: TaskStatus[] = ['intake', 'planning', 'executing', 'blocked', 'done', 'cancelled'];
  return (valid.includes(lower as TaskStatus) ? lower : 'intake') as TaskStatus;
}

export function normalizePhase(raw: string): OrchestratorPhase {
  const snake = raw
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
  const valid: OrchestratorPhase[] = [
    'intake', 'plan', 'parse_plan', 'select_subtask', 'execute',
    'parse_execution', 'validate', 'complete_subtask', 'replan', 'done', 'blocked',
  ];
  return (valid.includes(snake as OrchestratorPhase) ? snake : 'intake') as OrchestratorPhase;
}
```

### Verification
- [x] `npx tsc --noEmit` passes with no errors referencing the new types ✅ verified
- [x] `normalizeStatus("Executing")` returns `"executing"` ✅ verified
- [x] `normalizePhase("ParsePlan")` returns `"parse_plan"` ✅ verified

---

## Phase 2: React Hook

**Goal:** Single hook that wraps all Tauri commands. All components read state through this hook.

**File:** `src/hooks/tauri/orchestrator.ts` — **Create new file.**

```typescript
import { useCallback, useEffect, useRef, useState } from "react";
import { logInvokeError, tauriInvoke } from "./invoke";
import type {
  ExecutionResult,
  OrchestratorState,
  OrchestratorSettings,
  Plan,
  TaskSummary,
  ValidationResult,
} from "./types";
import { DEFAULT_ORCHESTRATOR_SETTINGS } from "./types";

export function useOrchestrator() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Debounce timer ref for settings saves
  const settingsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load task list
  const refresh = useCallback(async () => {
    try {
      const result = await tauriInvoke<{ tasks: TaskSummary[] }>(
        "get_orchestrator_task_list"
      );
      setTasks(result.tasks);
      setError(null);
    } catch (e) {
      logInvokeError("useOrchestrator", "Failed to load tasks", e);
      setError("Failed to load orchestrator tasks");
    } finally {
      setLoading(false);
    }
  }, []);

  // Start a new task
  const startTask = useCallback(async (request: string): Promise<string> => {
    const taskId = await tauriInvoke<string>("start_orchestrator_task", {
      request,
    });
    await refresh();
    return taskId;
  }, [refresh]);

  // Get detailed state for a task
  const getTaskState = useCallback(
    async (taskId: string): Promise<OrchestratorState | null> => {
      try {
        const state = await tauriInvoke<OrchestratorState>(
          "get_orchestrator_state",
          { task_id: taskId }
        );
        return state;
      } catch (e) {
        logInvokeError("useOrchestrator", "Failed to get task state", e);
        return null;
      }
    },
    []
  );

  // Get plan for a task
  const getTaskPlan = useCallback(
    async (taskId: string): Promise<Plan | null> => {
      try {
        const result = await tauriInvoke<{ plan: Plan | null }>(
          "get_orchestrator_plan",
          { task_id: taskId }
        );
        return result.plan;
      } catch (e) {
        logInvokeError("useOrchestrator", "Failed to get task plan", e);
        return null;
      }
    },
    []
  );

  // Get execution result for a task
  const getExecutionResult = useCallback(
    async (taskId: string): Promise<ExecutionResult | null> => {
      try {
        return await tauriInvoke<ExecutionResult | null>(
          "get_execution_result",
          { task_id: taskId }
        );
      } catch (e) {
        logInvokeError("useOrchestrator", "Failed to get execution result", e);
        return null;
      }
    },
    []
  );

  // Get validation result for a task
  const getValidationResult = useCallback(
    async (taskId: string): Promise<ValidationResult | null> => {
      try {
        return await tauriInvoke<ValidationResult | null>(
          "get_validation_result",
          { task_id: taskId }
        );
      } catch (e) {
        logInvokeError("useOrchestrator", "Failed to get validation result", e);
        return null;
      }
    },
    []
  );

  // Cancel a task
  const cancelTask = useCallback(
    async (taskId: string) => {
      await tauriInvoke("cancel_orchestrator_task", { task_id: taskId });
      await refresh();
    },
    [refresh]
  );

  // Respond to blocked task
  const respondToBlocked = useCallback(
    async (taskId: string, userInput: string): Promise<OrchestratorState> => {
      const state = await tauriInvoke<OrchestratorState>(
        "respond_to_blocked",
        { task_id: taskId, user_input: userInput }
      );
      await refresh();
      return state;
    },
    [refresh]
  );

  // Get settings (with error handling + default fallback)
  const getSettings = useCallback(async (): Promise<OrchestratorSettings> => {
    try {
      return await tauriInvoke<OrchestratorSettings>(
        "get_orchestrator_settings"
      );
    } catch (e) {
      logInvokeError(
        "useOrchestrator",
        "Failed to load settings, using defaults",
        e
      );
      return DEFAULT_ORCHESTRATOR_SETTINGS;
    }
  }, []);

  // Update settings (debounced — 300ms to avoid hammering disk writes)
  const updateSettings = useCallback(
    async (settings: OrchestratorSettings) => {
      if (settingsTimerRef.current) {
        clearTimeout(settingsTimerRef.current);
      }
      settingsTimerRef.current = setTimeout(async () => {
        try {
          await tauriInvoke("update_orchestrator_settings", { settings });
        } catch (e) {
          logInvokeError("useOrchestrator", "Failed to save settings", e);
        }
      }, 300);
    },
    []
  );

  // Initial load
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (settingsTimerRef.current) {
        clearTimeout(settingsTimerRef.current);
      }
    };
  }, []);

  return {
    tasks,
    loading,
    error,
    startTask,
    getTaskState,
    getTaskPlan,
    getExecutionResult,
    getValidationResult,
    cancelTask,
    respondToBlocked,
    getSettings,
    updateSettings,
    refresh,
  };
}

/**
 * Lightweight hook for settings-only access.
 * Use this in the Settings page to avoid fetching the task list.
 */
export function useOrchestratorSettings() {
  const settingsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getSettings = useCallback(async (): Promise<OrchestratorSettings> => {
    try {
      return await tauriInvoke<OrchestratorSettings>(
        "get_orchestrator_settings"
      );
    } catch (e) {
      logInvokeError(
        "useOrchestratorSettings",
        "Failed to load settings, using defaults",
        e
      );
      return DEFAULT_ORCHESTRATOR_SETTINGS;
    }
  }, []);

  const updateSettings = useCallback(
    async (settings: OrchestratorSettings) => {
      if (settingsTimerRef.current) {
        clearTimeout(settingsTimerRef.current);
      }
      settingsTimerRef.current = setTimeout(async () => {
        try {
          await tauriInvoke("update_orchestrator_settings", { settings });
        } catch (e) {
          logInvokeError("useOrchestratorSettings", "Failed to save settings", e);
        }
      }, 300);
    },
    []
  );

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (settingsTimerRef.current) {
        clearTimeout(settingsTimerRef.current);
      }
    };
  }, []);

  return { getSettings, updateSettings };
}
```

**File:** `src/hooks/useTauri.ts` — **Add** this export line (at the end, before the closing):

```typescript
export * from "./tauri/orchestrator";
```

### Verification
- [x] `npx tsc --noEmit` passes ✅ verified
- [x] [ ] ✅ verifiedThe hook can be imported: `import { useOrchestrator } from "../hooks/useTauri"`
- [x] [ ] ✅ verifiedThe settings hook can be imported: `import { useOrchestratorSettings } from "../hooks/useTauri"`

---

## Phase 3: Leaf Components

**Goal:** Build the simpler components that have no internal routing or complex state — SubtaskList, NewTaskModal, and TaskList.

> **All CSS below uses verified design system variables.** See Appendix A for the full variable map.

### 3.1 SubtaskList

**File:** `src/components/orchestrator/SubtaskList.tsx` — **Create new file.**

```typescript
import { CheckCircle, Circle, XCircle, Clock } from "lucide-react";
import type { Subtask } from "../../hooks/tauri/types";
import styles from "./SubtaskList.module.css";

interface SubtaskListProps {
  subtasks: Subtask[];
}

export function SubtaskList({ subtasks }: SubtaskListProps) {
  return (
    <div className={styles.subtaskList}>
      {subtasks.map((subtask, index) => (
        <div
          key={subtask.id}
          className={`${styles.subtask} ${styles[subtask.status]}`}
        >
          <div className={styles.subtaskHeader}>
            <div className={styles.subtaskIcon}>
              {getSubtaskIcon(subtask.status)}
            </div>
            <div className={styles.subtaskInfo}>
              <h5 className={styles.subtaskTitle}>{subtask.title}</h5>
              {subtask.depends_on.length > 0 && (
                <span className={styles.dependsOn}>
                  Depends on: {subtask.depends_on.join(", ")}
                </span>
              )}
            </div>
            <span className={styles.subtaskNumber}>{index + 1}</span>
          </div>

          <p className={styles.subtaskDescription}>{subtask.description}</p>

          {subtask.acceptance_criteria.length > 0 && (
            <div className={styles.acceptanceCriteria}>
              <strong>Acceptance Criteria:</strong>
              <ul>
                {subtask.acceptance_criteria.map((criteria, i) => (
                  <li key={i}>{criteria}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function getSubtaskIcon(status: string) {
  switch (status) {
    case "completed":
      return <CheckCircle size={18} className={styles.iconCompleted} />;
    case "failed":
    case "blocked":
      return <XCircle size={18} className={styles.iconFailed} />;
    case "executing":
      return <Clock size={18} className={styles.iconExecuting} />;
    default:
      return <Circle size={18} className={styles.iconPending} />;
  }
}
```

**File:** `src/components/orchestrator/SubtaskList.module.css` — **Create new file.**

```css
.subtaskList {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.subtask {
  padding: 0.75rem 1rem;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: var(--bg-surface);
  transition: border-color 0.15s ease;
}

.subtask.pending {
  opacity: 0.7;
}

.subtask.executing {
  border-color: var(--accent);
  background: var(--state-active-overlay);
}

.subtask.completed {
  border-color: var(--success);
}

.subtask.failed,
.subtask.blocked {
  border-color: var(--danger);
}

.subtaskHeader {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.subtaskIcon {
  flex-shrink: 0;
}

.subtaskInfo {
  flex: 1;
  min-width: 0;
}

.subtaskTitle {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text-primary);
  margin: 0;
}

.subtaskNumber {
  font-size: 0.75rem;
  color: var(--text-muted);
  background: var(--bg-elevated);
  padding: 0.125rem 0.5rem;
  border-radius: 4px;
  flex-shrink: 0;
}

.subtaskDescription {
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin: 0 0 0.5rem 0;
  line-height: 1.4;
}

.dependsOn {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.acceptanceCriteria {
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin-top: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--border-subtle);
}

.acceptanceCriteria strong {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.acceptanceCriteria ul {
  margin: 0.25rem 0 0 0;
  padding-left: 1.25rem;
}

.acceptanceCriteria li {
  font-size: 0.78rem;
  line-height: 1.4;
}

.iconCompleted { color: var(--success); }
.iconFailed { color: var(--danger); }
.iconExecuting { color: var(--accent); }
.iconPending { color: var(--text-muted); }
```

### 3.2 NewTaskModal

**File:** `src/components/orchestrator/NewTaskModal.tsx` — **Create new file.**

```typescript
import { useState } from "react";
import { X } from "lucide-react";
import styles from "./NewTaskModal.module.css";

interface NewTaskModalProps {
  onSubmit: (request: string) => Promise<void>;
  onCancel: () => void;
}

export function NewTaskModal({ onSubmit, onCancel }: NewTaskModalProps) {
  const [request, setRequest] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!request.trim()) return;

    setSubmitting(true);
    try {
      await onSubmit(request);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.modalOverlay}>
      <div className={styles.modal}>
        <div className={styles.modalHeader}>
          <h3>Create New Task</h3>
          <button className={styles.closeBtn} onClick={onCancel}>
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className={styles.modalBody}>
            <label htmlFor="orch-request">What would you like to accomplish?</label>
            <textarea
              id="orch-request"
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              placeholder="Describe the coding task you want the orchestrator to plan and execute..."
              className={styles.textarea}
              rows={6}
              autoFocus
            />
            <p className={styles.hint}>
              The orchestrator will break this down into subtasks, execute them
              via pi, and validate the results automatically.
            </p>
          </div>

          <div className={styles.modalFooter}>
            <button
              type="button"
              className={styles.cancelBtn}
              onClick={onCancel}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={styles.submitBtn}
              disabled={!request.trim() || submitting}
            >
              {submitting ? "Starting..." : "Start Task"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

**File:** `src/components/orchestrator/NewTaskModal.module.css` — **Create new file.**

```css
.modalOverlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 2rem;
}

.modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  width: 100%;
  max-width: 560px;
  box-shadow: var(--shadow-lg);
}

.modalHeader {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid var(--border-subtle);
}

.modalHeader h3 {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.modalBody {
  padding: 1.5rem;
}

.modalBody label {
  display: block;
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 0.5rem;
}

.textarea {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 0.9rem;
  font-family: inherit;
  resize: vertical;
  min-height: 6rem;
}

.textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 4px rgba(245, 200, 66, 0.14);
}

.hint {
  font-size: 0.8rem;
  color: var(--text-muted);
  margin: 0.75rem 0 0 0;
  line-height: 1.4;
}

.modalFooter {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  padding: 1rem 1.5rem;
  border-top: 1px solid var(--border-subtle);
}

.cancelBtn {
  padding: 0.5rem 1rem;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.15s ease;
}

.cancelBtn:hover {
  background: var(--state-hover-overlay);
}

.cancelBtn:disabled {
  opacity: var(--state-disabled-opacity);
  cursor: not-allowed;
}

.submitBtn {
  padding: 0.5rem 1.25rem;
  border-radius: var(--radius-sm);
  border: none;
  background: var(--accent);
  color: rgba(10, 22, 40, 0.95);
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.submitBtn:hover {
  background: var(--accent-hover);
}

.submitBtn:disabled {
  opacity: var(--state-disabled-opacity);
  cursor: not-allowed;
}

.closeBtn {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0.25rem;
  border-radius: 4px;
  transition: all 0.15s ease;
}

.closeBtn:hover {
  color: var(--text-primary);
  background: var(--state-hover-overlay);
}
```

### 3.3 TaskList

**File:** `src/components/orchestrator/TaskList.tsx` — **Create new file.**

```typescript
import {
  Clock,
  CheckCircle,
  XCircle,
  PauseCircle,
  AlertCircle,
} from "lucide-react";
import type {
  TaskSummary,
  TaskStatus,
  OrchestratorPhase,
} from "../../hooks/tauri/types";
import { normalizeStatus, normalizePhase } from "../../hooks/tauri/types";
import styles from "./TaskList.module.css";

interface TaskListProps {
  tasks: TaskSummary[];
  loading: boolean;
  selectedTaskId: string | null;
  onSelectTask: (id: string) => void;
  onCancelTask: (id: string) => void;
}

export function TaskList({
  tasks,
  loading,
  selectedTaskId,
  onSelectTask,
  onCancelTask,
}: TaskListProps) {
  if (loading) {
    return <div className={styles.loading}>Loading tasks...</div>;
  }

  if (tasks.length === 0) {
    return (
      <div className={styles.empty}>
        <h3>No Tasks Yet</h3>
        <p>Start by creating a new task to plan and execute coding work.</p>
      </div>
    );
  }

  return (
    <div className={styles.taskList}>
      {tasks.map((task) => {
        const status = normalizeStatus(task.status);
        const phase = normalizePhase(task.phase);
        return (
          <div
            key={task.id}
            className={`${styles.taskCard} ${
              selectedTaskId === task.id ? styles.selected : ""
            }`}
            onClick={() => onSelectTask(task.id)}
          >
            <div className={styles.taskHeader}>
              <div className={styles.taskStatus}>
                {getStatusIcon(status)}
              </div>
              <div className={styles.taskInfo}>
                <h4 className={styles.taskRequest}>{task.request}</h4>
                <div className={styles.taskMeta}>
                  <span className={styles.phaseBadge}>
                    {formatPhaseValue(phase)}
                  </span>
                  <span className={styles.timestamp}>
                    {formatTimeAgo(task.created_at)}
                  </span>
                </div>
              </div>
            </div>

            {status === "executing" && (
              <button
                className={styles.cancelBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  if (
                    window.confirm(
                      "Are you sure you want to cancel this task?"
                    )
                  ) {
                    onCancelTask(task.id);
                  }
                }}
              >
                Cancel
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function getStatusIcon(status: TaskStatus) {
  switch (status) {
    case "done":
      return <CheckCircle size={20} className={styles.statusDone} />;
    case "cancelled":
      return <XCircle size={20} className={styles.statusCancelled} />;
    case "blocked":
      return <AlertCircle size={20} className={styles.statusBlocked} />;
    case "executing":
    case "planning":
      return <Clock size={20} className={styles.statusActive} />;
    default:
      return <PauseCircle size={20} className={styles.statusPending} />;
  }
}

function formatPhaseValue(phase: OrchestratorPhase): string {
  return phase
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// created_at is a Unix epoch number (seconds) from Rust's chrono::serde::ts_seconds
function formatTimeAgo(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const now = new Date();
  const diff = Math.max(
    0,
    Math.floor((now.getTime() - date.getTime()) / 1000)
  );

  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
```

**File:** `src/components/orchestrator/TaskList.module.css` — **Create new file.**

```css
.taskList {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.loading {
  padding: 2rem;
  text-align: center;
  color: var(--text-secondary);
  font-size: 0.9rem;
}

.empty {
  padding: 3rem 2rem;
  text-align: center;
  color: var(--text-muted);
}

.empty h3 {
  font-size: 1.1rem;
  color: var(--text-primary);
  margin: 0 0 0.5rem 0;
}

.empty p {
  font-size: 0.9rem;
  margin: 0;
}

.taskCard {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: all 0.15s ease;
}

.taskCard:hover {
  background: var(--state-hover-overlay);
  border-color: var(--accent);
}

.taskCard.selected {
  border-color: var(--accent);
  background: var(--accent-subtle);
}

.taskHeader {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex: 1;
  min-width: 0;
}

.taskStatus {
  flex-shrink: 0;
}

.taskInfo {
  flex: 1;
  min-width: 0;
}

.taskRequest {
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--text-primary);
  margin: 0 0 0.25rem 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.taskMeta {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.8rem;
}

.phaseBadge {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  border-radius: 4px;
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 0.75rem;
  text-transform: capitalize;
}

.timestamp {
  color: var(--text-muted);
}

.cancelBtn {
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--danger-subtle);
  background: transparent;
  color: var(--danger);
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.15s ease;
  flex-shrink: 0;
  margin-left: 0.75rem;
}

.cancelBtn:hover {
  background: var(--danger-subtle);
}

.statusDone { color: var(--success); }
.statusCancelled { color: var(--text-muted); }
.statusBlocked { color: var(--warning); }
.statusActive { color: var(--accent); }
.statusPending { color: var(--text-muted); }
```

### Verification
- [x] [ ] ✅ verifiedAll 6 files created
- [x] `npx tsc --noEmit` passes ✅ verified
- [x] [ ] ✅ verifiedAll CSS variables match the design system (no `--accent-color`, `--error-text`, etc.)

---

## Phase 4: TaskDetail Component

**Goal:** The right-panel detail view with polling, blocked-task handling, and plan display.

**File:** `src/components/orchestrator/TaskDetail.tsx` — **Create new file.**

```typescript
import { useEffect, useRef, useState } from "react";
import { X, AlertTriangle } from "lucide-react";
import type { OrchestratorState, Plan } from "../../hooks/tauri/types";
import { SubtaskList } from "./SubtaskList";
import styles from "./TaskDetail.module.css";

interface TaskDetailProps {
  taskId: string;
  onClose: () => void;
  getState: (id: string) => Promise<OrchestratorState | null>;
  getPlan: (id: string) => Promise<Plan | null>;
  onCancel: (id: string) => void;
  respondToBlocked?: (
    id: string,
    input: string
  ) => Promise<OrchestratorState>;
}

export function TaskDetail({
  taskId,
  onClose,
  getState,
  getPlan,
  onCancel,
  respondToBlocked,
}: TaskDetailProps) {
  const [state, setState] = useState<OrchestratorState | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(true);
  const [blockedInput, setBlockedInput] = useState("");
  const [submittingGuidance, setSubmittingGuidance] = useState(false);

  // Stale request guard: only the latest request resolves state
  const loadCounterRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Hold latest prop refs for use in interval closures
  const getStateRef = useRef(getState);
  const getPlanRef = useRef(getPlan);
  getStateRef.current = getState;
  getPlanRef.current = getPlan;

  // Determine if task is in a terminal (non-active) state
  const isTerminal =
    state !== null &&
    (state.phase === "done" ||
      state.phase === "blocked" ||
      state.task.status === "cancelled");

  useEffect(() => {
    const loadTask = async () => {
      const counter = ++loadCounterRef.current;
      const [taskState, taskPlan] = await Promise.all([
        getStateRef.current(taskId),
        getPlanRef.current(taskId),
      ]);
      // Only apply results if this is still the latest request
      if (counter === loadCounterRef.current) {
        setState(taskState);
        setPlan(taskPlan);
        setLoading(false);
      }
    };

    loadTask();

    // Only poll if task is not yet known to be terminal
    if (!isTerminal) {
      intervalRef.current = setInterval(loadTask, 2000);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [taskId, isTerminal]);

  const handleSubmitGuidance = async () => {
    if (!respondToBlocked || !blockedInput.trim()) return;

    setSubmittingGuidance(true);
    try {
      await respondToBlocked(taskId, blockedInput);
      setBlockedInput("");
    } catch (err) {
      console.error("Failed to submit guidance:", err);
    } finally {
      setSubmittingGuidance(false);
    }
  };

  if (loading) {
    return (
      <div className={styles.detailPanel}>
        <div className={styles.loading}>Loading task details...</div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className={styles.detailPanel}>
        <div className={styles.error}>Task not found</div>
      </div>
    );
  }

  return (
    <div className={styles.detailPanel}>
      <div className={styles.detailHeader}>
        <h3>Task Details</h3>
        <button className={styles.closeBtn} onClick={onClose}>
          <X size={20} />
        </button>
      </div>

      <div className={styles.taskInfo}>
        <div className={styles.requestSection}>
          <label>Request</label>
          <p className={styles.requestText}>{state.task.user_request}</p>
        </div>

        <div className={styles.statusSection}>
          <div className={styles.statusRow}>
            <span>Status:</span>
            <span className={styles.statusValue}>{state.task.status}</span>
          </div>
          <div className={styles.statusRow}>
            <span>Phase:</span>
            <span className={styles.statusValue}>{state.phase}</span>
          </div>
          <div className={styles.statusRow}>
            <span>Mode:</span>
            <span className={styles.statusValue}>{state.task.mode}</span>
          </div>
        </div>

        {state.phase === "blocked" && (
          <div className={styles.blockedSection}>
            <AlertTriangle size={20} className={styles.warningIcon} />
            <h4>Task Blocked</h4>
            <p>{state.error_log[state.error_log.length - 1]}</p>
            <textarea
              value={blockedInput}
              onChange={(e) => setBlockedInput(e.target.value)}
              placeholder="Provide guidance to unblock the task..."
              className={styles.blockedInput}
              disabled={submittingGuidance}
            />
            <button
              className={styles.submitGuidanceBtn}
              onClick={handleSubmitGuidance}
              disabled={!blockedInput.trim() || submittingGuidance}
            >
              {submittingGuidance ? "Submitting..." : "Submit Guidance"}
            </button>
          </div>
        )}

        {state.error_log.length > 0 && (
          <div className={styles.errorLog}>
            <h4>Error Log</h4>
            <ul>
              {state.error_log.slice(-5).map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {plan && plan.subtasks.length > 0 && (
        <div className={styles.planSection}>
          <h4>Plan</h4>
          <p className={styles.goal}>{plan.goal}</p>
          <SubtaskList subtasks={plan.subtasks} />
        </div>
      )}

      {state.task.status === "executing" && (
        <button
          className={styles.cancelTaskBtn}
          onClick={() => {
            if (
              window.confirm("Are you sure you want to cancel this task?")
            ) {
              onCancel(taskId);
            }
          }}
        >
          Cancel Task
        </button>
      )}
    </div>
  );
}
```

**File:** `src/components/orchestrator/TaskDetail.module.css` — **Create new file.**

```css
.detailPanel {
  padding: 20px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow-y: auto;
  max-height: calc(100vh - 12rem);
}

.detailHeader {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--border-subtle);
}

.detailHeader h3 {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.closeBtn {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0.25rem;
  border-radius: 4px;
  transition: all 0.15s ease;
}

.closeBtn:hover {
  color: var(--text-primary);
  background: var(--state-hover-overlay);
}

.loading {
  text-align: center;
  color: var(--text-secondary);
  padding: 2rem;
}

.error {
  text-align: center;
  color: var(--danger);
  padding: 2rem;
}

.taskInfo {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.requestSection label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 0.25rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.requestText {
  font-size: 0.95rem;
  color: var(--text-primary);
  margin: 0;
  line-height: 1.5;
}

.statusSection {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 1rem;
  background: var(--bg-elevated);
  border-radius: var(--radius-sm);
}

.statusRow {
  display: flex;
  justify-content: space-between;
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.statusValue {
  color: var(--text-primary);
  font-weight: 500;
  text-transform: capitalize;
}

.blockedSection {
  padding: 1rem;
  background: var(--warning-subtle);
  border: 1px solid var(--warning);
  border-radius: var(--radius-sm);
  text-align: center;
}

.blockedSection h4 {
  color: var(--warning);
  margin: 0.5rem 0;
  font-size: 0.95rem;
}

.blockedSection p {
  font-size: 0.85rem;
  color: var(--text-secondary);
  margin: 0 0 1rem 0;
}

.warningIcon {
  color: var(--warning);
}

.blockedInput {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 0.85rem;
  resize: vertical;
  min-height: 4rem;
  margin-bottom: 0.75rem;
  font-family: inherit;
}

.blockedInput:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 4px rgba(245, 200, 66, 0.14);
}

.submitGuidanceBtn {
  padding: 0.5rem 1rem;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: rgba(10, 22, 40, 0.95);
  border: none;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.submitGuidanceBtn:hover {
  background: var(--accent-hover);
}

.submitGuidanceBtn:disabled {
  opacity: var(--state-disabled-opacity);
  cursor: not-allowed;
}

.errorLog {
  padding: 1rem;
  background: var(--danger-subtle);
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
}

.errorLog h4 {
  font-size: 0.85rem;
  color: var(--danger);
  margin: 0 0 0.5rem 0;
}

.errorLog ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

.errorLog li {
  font-size: 0.8rem;
  color: var(--danger);
  padding: 0.25rem 0;
  border-bottom: 1px solid var(--border-subtle);
}

.errorLog li:last-child {
  border-bottom: none;
}

.planSection {
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border-subtle);
}

.planSection h4 {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 0.5rem 0;
}

.goal {
  font-size: 0.85rem;
  color: var(--text-secondary);
  margin: 0 0 1rem 0;
  line-height: 1.5;
}

.cancelTaskBtn {
  width: 100%;
  margin-top: 1rem;
  padding: 0.625rem;
  border-radius: var(--radius-sm);
  background: transparent;
  border: 1px solid var(--danger-subtle);
  color: var(--danger);
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.15s ease;
}

.cancelTaskBtn:hover {
  background: var(--danger-subtle);
}
```

### Verification
- [x] [ ] ✅ verifiedBoth files created
- [x] `npx tsc --noEmit` passes ✅ verified
- [x] [ ] ✅ verifiedAll CSS uses verified design system variables

---

## Phase 5: Page Component

**Goal:** The main Orchestrator page that composes all components.

**File:** `src/pages/Orchestrator.tsx` — **Create new file.**

```typescript
import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Plus, RefreshCw, AlertCircle } from "lucide-react";
import { useOrchestrator } from "../hooks/useTauri";
import { TaskList } from "../components/orchestrator/TaskList";
import { TaskDetail } from "../components/orchestrator/TaskDetail";
import { NewTaskModal } from "../components/orchestrator/NewTaskModal";
import styles from "./Orchestrator.module.css";

export function Orchestrator() {
  const {
    tasks,
    loading,
    error,
    startTask,
    refresh,
    getTaskState,
    getTaskPlan,
    cancelTask,
    getSettings,
    respondToBlocked,
  } = useOrchestrator();

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [orchSettings, setOrchSettings] = useState<{ enabled: boolean } | null>(
    null
  );

  // Load orchestrator settings to check if enabled
  useEffect(() => {
    getSettings().then(setOrchSettings);
  }, [getSettings]);

  const handleStartTask = async (request: string) => {
    setStartError(null);
    try {
      const taskId = await startTask(request);
      setShowNewTaskModal(false);
      setSelectedTaskId(taskId);
    } catch (err) {
      setStartError(
        err instanceof Error ? err.message : "Failed to start task"
      );
    }
  };

  const handleCancelTask = async (taskId: string) => {
    if (
      window.confirm(
        "Are you sure you want to cancel this task? This action cannot be undone."
      )
    ) {
      await cancelTask(taskId);
      if (selectedTaskId === taskId) {
        setSelectedTaskId(null);
      }
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Orchestrator</h1>
          <p className={styles.subtitle}>
            Plan and execute coding tasks with AI agents
          </p>
        </div>
        <div className={styles.actions}>
          <button className={styles.refreshBtn} onClick={() => refresh()}>
            <RefreshCw size={18} />
            Refresh
          </button>
          <button
            className={styles.primaryBtn}
            onClick={() => setShowNewTaskModal(true)}
            disabled={!orchSettings?.enabled}
          >
            <Plus size={18} />
            New Task
          </button>
        </div>
      </div>

      {/* Pre-flight warning: orchestrator not enabled */}
      {orchSettings && !orchSettings.enabled && (
        <div className={styles.warningBanner}>
          <AlertCircle size={18} />
          <span>
            Orchestrator is disabled.{" "}
            <Link to="/settings" className={styles.settingsLink}>
              Enable it in Settings
            </Link>{" "}
            to create tasks.
          </span>
        </div>
      )}

      {error && (
        <div className={styles.errorBanner}>
          <AlertCircle size={18} />
          <span>{error}</span>
        </div>
      )}

      {startError && (
        <div className={styles.errorBanner}>
          <AlertCircle size={18} />
          <span>{startError}</span>
        </div>
      )}

      <div className={styles.content}>
        <TaskList
          tasks={tasks}
          loading={loading}
          selectedTaskId={selectedTaskId}
          onSelectTask={setSelectedTaskId}
          onCancelTask={handleCancelTask}
        />

        {selectedTaskId && (
          <TaskDetail
            taskId={selectedTaskId}
            onClose={() => setSelectedTaskId(null)}
            getState={getTaskState}
            getPlan={getTaskPlan}
            onCancel={handleCancelTask}
            respondToBlocked={respondToBlocked}
          />
        )}
      </div>

      {showNewTaskModal && (
        <NewTaskModal
          onSubmit={handleStartTask}
          onCancel={() => setShowNewTaskModal(false)}
        />
      )}
    </div>
  );
}
```

**File:** `src/pages/Orchestrator.module.css` — **Create new file.**

```css
.page {
  padding: 2rem;
  max-width: 1400px;
  margin: 0 auto;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 24px;
}

.title {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.subtitle {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.actions {
  display: flex;
  gap: 0.75rem;
}

.refreshBtn,
.primaryBtn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  border: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.refreshBtn:hover {
  background: var(--state-hover-overlay);
  color: var(--text-primary);
}

.primaryBtn {
  background: var(--accent);
  border-color: transparent;
  color: rgba(10, 22, 40, 0.95);
  font-weight: 600;
}

.primaryBtn:hover {
  background: var(--accent-hover);
}

.primaryBtn:disabled {
  opacity: var(--state-disabled-opacity);
  cursor: not-allowed;
}

.warningBanner,
.errorBanner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  margin-bottom: 1.5rem;
  font-size: 12px;
}

.warningBanner {
  background: var(--warning-subtle);
  color: var(--warning);
}

.errorBanner {
  background: var(--danger-subtle);
  color: var(--danger);
}

.settingsLink {
  color: inherit;
  text-decoration: underline;
  font-weight: 500;
}

.content {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
}

@media (max-width: 1200px) {
  .content {
    grid-template-columns: 1fr;
  }
}
```

### Verification
- [x] [ ] ✅ verifiedBoth files created
- [x] `npx tsc --noEmit` passes ✅ verified
- [x] [ ] ✅ verifiedPage renders: title, subtitle, refresh/new-task buttons
- [x] [ ] ✅ verified"New Task" button is disabled when `orchSettings.enabled === false`

---

## Phase 6: Routing, Navigation & Settings

**Goal:** Wire the page into the app — add the route, sidebar item, and settings tab.

### 6.1 Add Route

**File:** `src/App.tsx` — **Modify.** Two changes:

1. Add import at top (after the existing imports):
```typescript
import { Orchestrator } from "./pages/Orchestrator";
```

2. Add route inside `<Routes>` (after the `/audit` route):
```tsx
<Route path="/orchestrator" element={<Orchestrator />} />
```

### 6.2 Add Sidebar Nav Item

**File:** `src/components/Sidebar.tsx` — **Modify.** Two changes:

1. Add `Bot` to the lucide-react import:
```typescript
import {
  Activity,
  Clock,
  FileText,
  Settings,
  Shield,
  Gauge,
  Bot,
} from "lucide-react";
```

2. Add this entry to the `navItems` array (between `audit` and `security`):
```typescript
{ to: "/orchestrator", icon: Bot, label: "Orchestrator" },
```

### 6.3 Create Settings Section

The settings component must follow the exact same patterns as `BehaviorSection.tsx` — using `styles.section`, `styles.subSection`, `styles.subTitle`, `styles.subDesc`, `styles.formRow`, `styles.formGroup`, `styles.label`, `styles.input` (all from `Settings.module.css`), plus the `ToggleRow` component from `./components`.

**File:** `src/components/settings/OrchestratorSection.tsx` — **Create new file.**

```typescript
import { useState, useEffect } from "react";
import { useOrchestratorSettings } from "../../hooks/useTauri";
import type { OrchestratorSettings } from "../../hooks/tauri/types";
import { DEFAULT_ORCHESTRATOR_SETTINGS } from "../../hooks/tauri/types";
import { ToggleRow } from "./components";
import { Cpu, Wrench } from "lucide-react";
import styles from "../../pages/Settings.module.css";

export function OrchestratorSection() {
  const { getSettings, updateSettings } = useOrchestratorSettings();
  const [settings, setSettings] = useState<OrchestratorSettings | null>(null);
  const [draft, setDraft] = useState<{
    planning_model: string;
    executor_model: string;
    timeout: string;
    retries: string;
    maxFiles: string;
    maxToolCalls: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSettings().then((s) => {
      setSettings(s);
      setDraft({
        planning_model: s.planning_model,
        executor_model: s.executor_model,
        timeout: String(s.executor_timeout_secs),
        retries: String(s.max_subtask_retries),
        maxFiles: String(s.max_files_per_subtask),
        maxToolCalls: String(s.max_tool_calls),
      });
    });
  }, [getSettings]);

  if (!settings || !draft) return null;

  const toggleEnabled = async () => {
    const updated = { ...settings, enabled: !settings.enabled };
    setSettings(updated);
    updateSettings(updated);
  };

  const clampInt = (raw: string, min: number, max: number, fallback: number) => {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  const saveModelConfig = async () => {
    setSaving(true);
    try {
      const updated: OrchestratorSettings = {
        ...settings,
        planning_model: draft.planning_model.trim(),
        executor_model: draft.executor_model.trim(),
      };
      setSettings(updated);
      updateSettings(updated);
    } finally {
      setSaving(false);
    }
  };

  const saveLimits = async () => {
    setSaving(true);
    try {
      const updated: OrchestratorSettings = {
        ...settings,
        executor_timeout_secs: clampInt(draft.timeout, 60, 3600, settings.executor_timeout_secs),
        max_subtask_retries: clampInt(draft.retries, 0, 5, settings.max_subtask_retries),
        max_files_per_subtask: clampInt(draft.maxFiles, 1, 50, settings.max_files_per_subtask),
        max_tool_calls: clampInt(draft.maxToolCalls, 1, 200, settings.max_tool_calls),
      };
      setSettings(updated);
      updateSettings(updated);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.section}>
      <h2 className={styles.sectionTitle}>Orchestrator</h2>

      <ToggleRow
        label="Enable Orchestrator"
        desc="Allow planning and execution of multi-step coding tasks via AI agents."
        enabled={settings.enabled}
        onToggle={toggleEnabled}
      />

      <div className={styles.subSection}>
        <h3 className={styles.subTitle}>
          <Cpu size={16} />
          Model Configuration
        </h3>
        <p className={styles.subDesc}>
          Models are routed through the Aelvyril gateway. These map to your configured provider models.
        </p>

        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label}>Planning Model</label>
            <input
              className={styles.input}
              value={draft.planning_model}
              onChange={(e) =>
                setDraft({ ...draft, planning_model: e.target.value })
              }
              placeholder="e.g., claude-sonnet-4-5-20250929"
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label}>Executor Model</label>
            <input
              className={styles.input}
              value={draft.executor_model}
              onChange={(e) =>
                setDraft({ ...draft, executor_model: e.target.value })
              }
              placeholder="e.g., claude-haiku-4-5"
            />
          </div>
        </div>

        <button className={styles.saveButton} onClick={saveModelConfig} disabled={saving}>
          {saving ? "Saving..." : "Save Models"}
        </button>
      </div>

      <div className={styles.subSection}>
        <h3 className={styles.subTitle}>
          <Wrench size={16} />
          Execution Limits
        </h3>
        <p className={styles.subDesc}>
          Control how pi executes subtasks — timeouts, retries, and resource limits.
        </p>

        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label}>Timeout (seconds)</label>
            <input
              className={styles.input}
              inputMode="numeric"
              value={draft.timeout}
              onChange={(e) =>
                setDraft({ ...draft, timeout: e.target.value })
              }
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label}>Max retries per subtask</label>
            <input
              className={styles.input}
              inputMode="numeric"
              value={draft.retries}
              onChange={(e) =>
                setDraft({ ...draft, retries: e.target.value })
              }
            />
          </div>
        </div>

        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.label}>Max files per subtask</label>
            <input
              className={styles.input}
              inputMode="numeric"
              value={draft.maxFiles}
              onChange={(e) =>
                setDraft({ ...draft, maxFiles: e.target.value })
              }
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label}>Max tool calls per subtask</label>
            <input
              className={styles.input}
              inputMode="numeric"
              value={draft.maxToolCalls}
              onChange={(e) =>
                setDraft({ ...draft, maxToolCalls: e.target.value })
              }
            />
          </div>
        </div>

        <button className={styles.saveButton} onClick={saveLimits} disabled={saving}>
          {saving ? "Saving..." : "Save Limits"}
        </button>
      </div>
    </div>
  );
}
```

> **Why `useOrchestratorSettings` instead of `useOrchestrator`?** The full hook fetches the task list on mount, which is unnecessary on the Settings page where we only need `getSettings`/`updateSettings`. The lightweight settings-only hook avoids this waste.

### 6.4 Update Settings Barrel Export

**File:** `src/components/settings/index.ts` — **Add** this line (at the end, before the closing):

```typescript
export { OrchestratorSection } from "./OrchestratorSection";
```

### 6.5 Add Settings Tab

**File:** `src/pages/Settings.tsx` — **Modify.** Four changes:

1. Add `Bot` to the lucide-react import:
```typescript
import { Shield, Eye, ListFilter, Power, Bot } from "lucide-react";
```

2. Import `OrchestratorSection`:
```typescript
import {
  ProvidersSection,
  GatewayKeySection,
  ListsSection,
  DetectionSection,
  BehaviorSection,
  OrchestratorSection,
} from "../components/settings";
```

3. Add `"orchestrator"` to the `SettingsTab` type:
```typescript
type SettingsTab = "providers" | "gateway" | "lists" | "detection" | "behavior" | "orchestrator";
```

4. Add entry to the `tabs` array (after behavior):
```typescript
{ id: "orchestrator", label: "Orchestrator", icon: Bot },
```

5. Add the conditional render (after the behavior line):
```tsx
{activeTab === "orchestrator" && <OrchestratorSection />}
```

### Verification
- [x] [ ] ✅ verifiedAll modified files compile (`npx tsc --noEmit`)
- [x] [ ] ✅ verified`/orchestrator` route renders the Orchestrator page
- [x] [ ] ✅ verified"Orchestrator" appears in sidebar with Bot icon
- [x] [ ] ✅ verifiedSettings page has an "Orchestrator" tab
- [x] [ ] ✅ verifiedSettings tab shows: Enable toggle, Model Configuration section, Execution Limits section
- [x] [ ] ✅ verifiedAll 6 fields configurable (planning_model, executor_model, timeout, retries, max_files, max_tool_calls)
- [x] [ ] ✅ verifiedSave buttons only write on explicit click (not on keystroke)

---

## Complete File Manifest

| # | File | Action | Phase |
|---|------|--------|-------|
| 1 | `src-tauri/src/commands/orchestrator.rs` | Modify (3 fixes) | 0 |
| 2 | `src-tauri/src/commands/mod.rs` | Modify (register 2 new commands) | 0 |
| 3 | `src/hooks/tauri/types.ts` | Append types | 1 |
| 4 | `src/hooks/tauri/orchestrator.ts` | Create | 2 |
| 5 | `src/hooks/useTauri.ts` | Add 1 export line | 2 |
| 6 | `src/components/orchestrator/SubtaskList.tsx` | Create | 3 |
| 7 | `src/components/orchestrator/SubtaskList.module.css` | Create | 3 |
| 8 | `src/components/orchestrator/NewTaskModal.tsx` | Create | 3 |
| 9 | `src/components/orchestrator/NewTaskModal.module.css` | Create | 3 |
| 10 | `src/components/orchestrator/TaskList.tsx` | Create | 3 |
| 11 | `src/components/orchestrator/TaskList.module.css` | Create | 3 |
| 12 | `src/components/orchestrator/TaskDetail.tsx` | Create | 4 |
| 13 | `src/components/orchestrator/TaskDetail.module.css` | Create | 4 |
| 14 | `src/pages/Orchestrator.tsx` | Create | 5 |
| 15 | `src/pages/Orchestrator.module.css` | Create | 5 |
| 16 | `src/App.tsx` | Modify (add import + route) | 6 |
| 17 | `src/components/Sidebar.tsx` | Modify (add import + nav item) | 6 |
| 18 | `src/components/settings/OrchestratorSection.tsx` | Create | 6 |
| 19 | `src/components/settings/index.ts` | Add 1 export line | 6 |
| 20 | `src/pages/Settings.tsx` | Modify (add tab + section) | 6 |

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| `normalizeStatus()` / `normalizePhase()` runtime helpers | Backend casing inconsistency between endpoints (Phase 0 Fix 1); frontend must handle both formats |
| Timestamps as `number` (Unix seconds) | Matches Rust's `chrono::serde::ts_seconds`; `formatTimeAgo()` multiplies by 1000 |
| Debounced settings saves (300ms) | Text inputs fire `onChange` per keystroke; without debounce, every keystroke writes the config file to disk |
| Polling stops on terminal states | Prevents unnecessary network traffic once task reaches `done`/`blocked`/`cancelled` |
| React Router `<Link>` not `<a href>` | Tauri SPA — `<a href>` causes full page reload |
| `loadCounterRef` stale-request guard | Rapidly switching between tasks could cause race conditions; counter ensures only the latest request resolves |
| `cancelled` excluded from TS `OrchestratorState` | It's `#[serde(skip)]` in Rust and never appears in JSON; derive from `task.status === 'cancelled'` |
| Shared `DEFAULT_ORCHESTRATOR_SETTINGS` | Single source of truth — hook and settings component both import from `types.ts` |
| `useOrchestratorSettings` separate hook | Settings page only needs get/update, not task list; avoids fetching tasks on the settings page |
| Settings use explicit Save buttons (not auto-save) | Matches existing `BehaviorSection` pattern (Rate Limits has a Save button). Model text inputs are awkward as auto-save because of debounce UX confusion |
| Execution/validation results via separate commands | `#[serde(skip)]` on `cancel_tx` prevents including results in OrchState; new commands keep serialization clean |

---

## Appendix A: Verified Design System Variables

CSS variables available in the Aelvyril design system (extracted from the codebase):

```css
/* Colors */
--accent               /* Primary accent: #f5c842 (gold) */
--accent-hover          /* Hover: #e8a020 */
--accent-subtle         /* Subtle bg: rgba(245, 200, 66, 0.12) */
--danger                /* Error/danger: #e05a6a */
--danger-subtle         /* Error subtle bg: rgba(224, 90, 106, 0.14) */
--success               /* Success: #4dd9e0 (cyan) */
--success-subtle        /* Success subtle bg: rgba(77, 217, 224, 0.12) */
--warning               /* Warning: #f5c842 (same as accent gold) */
--warning-subtle        /* Warning subtle bg: rgba(245, 200, 66, 0.12) */

/* Backgrounds */
--bg-primary             /* #0a1628 */
--bg-secondary           /* rgba(240, 244, 248, 0.06) — surface-1 */
--bg-surface             /* rgba(240, 244, 248, 0.1) — surface-2 */
--bg-elevated            /* rgba(240, 244, 248, 0.14) — tertiary/elevated */

/* Text */
--text-primary           /* #f0f4f8 */
--text-secondary         /* rgba(240, 244, 248, 0.75) */
--text-muted             /* rgba(240, 244, 248, 0.56) */

/* Borders */
--border                 /* rgba(240, 244, 248, 0.22) */
--border-subtle          /* rgba(240, 244, 248, 0.16) */

/* States */
--state-hover-overlay    /* rgba(240, 244, 248, 0.08) */
--state-active-overlay   /* rgba(240, 244, 248, 0.14) */
--state-disabled-opacity /* 0.45 */

/* Radius */
--radius-sm              /* 10px */
--radius-md              /* 12px */
--radius-lg              /* 14px */

/* Shadows */
--shadow-sm / --shadow-md / --shadow-lg

/* Typography */
--font-sans              /* Inter, system fonts */
--font-mono              /* JetBrains Mono, Fira Code */
```

### Common Settings.module.css Classes (verified)

These classes exist in `Settings.module.css` and are used by existing settings sections:

```
.section, .sectionTitle, .sectionDesc
.subSection, .subTitle, .subDesc
.formRow, .formGroup, .label, .input
.saveButton, .addButton
.toggleRow, .toggleLabel, .toggleDesc, .toggleSwitch, .toggleKnob
.timeoutRow, .timeoutOptions, .timeoutBtn
```

---

## Out of Scope

- Real-time WebSocket updates (polling is sufficient for v1)
- Task filtering and search
- Task history and analytics dashboard
- Export/import task definitions
- Visual diff viewer for touched files
- Integrated chat for blocked tasks
- Task templates for common operations
---

*Plan Version: 1.0*
*Last Updated: 2026-04-25 — All phases verified. Code implemented, builds pass, route fixed (was ComingSoon → now Orchestrator.tsx). All 30 verification items confirmed.*
