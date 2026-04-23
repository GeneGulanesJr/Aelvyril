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
