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

  // Ref to track terminal state — avoids effect re-run on state changes
  const isTerminalRef = useRef(false);

  // Determine if task is in a terminal (non-active) state
  const isTerminal = (s: typeof state): boolean =>
    s !== null &&
    (s.phase === "done" || s.phase === "blocked" || s.task.status === "cancelled");

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
        isTerminalRef.current = isTerminal(taskState);
      }
    };

    loadTask();

    // Only poll if task is not yet known to be terminal
    if (!isTerminalRef.current) {
      intervalRef.current = setInterval(loadTask, 2000);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

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
