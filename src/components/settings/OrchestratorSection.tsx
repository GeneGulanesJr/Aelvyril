import { useState, useEffect } from "react";
import { useOrchestratorSettings } from "../../hooks/useTauri";
import type { OrchestratorSettings } from "../../hooks/tauri/types";
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
