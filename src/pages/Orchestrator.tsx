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
