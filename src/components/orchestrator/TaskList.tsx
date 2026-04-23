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
