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
