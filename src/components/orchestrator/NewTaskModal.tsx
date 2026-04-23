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
