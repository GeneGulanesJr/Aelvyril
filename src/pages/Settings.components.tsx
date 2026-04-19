/**
 * Extracted components for Settings.tsx to reduce complexity
 * These components handle specific sections of the settings page
 */

import { Trash2, Bell } from "lucide-react";
import { useState } from "react";
import styles from "./Settings.module.css";

// ── Provider Form Component ───────────────────────────────────────────────

interface ProviderFormProps {
  onAdd: (provider: { name: string; baseUrl: string; models: string; apiKey: string }) => Promise<void>;
  onCancel: () => void;
}

export function ProviderForm({ onAdd, onCancel }: ProviderFormProps) {
  const [provider, setProvider] = useState({
    name: "",
    baseUrl: "",
    models: "",
    apiKey: "",
  });
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    if (!provider.name || !provider.baseUrl || !provider.apiKey) {
      setError("All fields except Models are required");
      return;
    }
    try {
      await onAdd(provider);
      setProvider({ name: "", baseUrl: "", models: "", apiKey: "" });
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className={styles.addForm}>
      <div className={styles.formRow}>
        <div className={styles.formGroup}>
          <label className={styles.label}>Provider Name</label>
          <input
            className={styles.input}
            placeholder="OpenAI"
            value={provider.name}
            onChange={(e) => setProvider({ ...provider, name: e.target.value })}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.label}>Base URL</label>
          <input
            className={styles.input}
            placeholder="https://api.openai.com/v1"
            value={provider.baseUrl}
            onChange={(e) => setProvider({ ...provider, baseUrl: e.target.value })}
          />
        </div>
      </div>
      <div className={styles.formRow}>
        <div className={styles.formGroup}>
          <label className={styles.label}>Models (comma-separated)</label>
          <input
            className={styles.input}
            placeholder="gpt-4o, gpt-4o-mini"
            value={provider.models}
            onChange={(e) => setProvider({ ...provider, models: e.target.value })}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.label}>API Key</label>
          <input
            className={styles.input}
            type="password"
            placeholder="sk-..."
            value={provider.apiKey}
            onChange={(e) => setProvider({ ...provider, apiKey: e.target.value })}
          />
        </div>
      </div>
      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.formActions}>
        <button className={styles.cancelButton} onClick={onCancel}>
          Cancel
        </button>
        <button className={styles.saveButton} onClick={handleSubmit}>
          Save Provider
        </button>
      </div>
    </div>
  );
}

// ── Provider Card Component ───────────────────────────────────────────────

interface ProviderCardProps {
  provider: { id: string; name: string; base_url: string; models: string[] };
  onRemove: (name: string) => void;
}

export function ProviderCard({ provider, onRemove }: ProviderCardProps) {
  return (
    <div key={provider.id} className={styles.providerCard}>
      <div className={styles.providerInfo}>
        <div className={styles.providerName}>{provider.name}</div>
        <div className={styles.providerMeta}>
          <span className={styles.providerUrl}>{provider.base_url}</span>
          {provider.models.map((m) => (
            <span key={m} className={styles.modelTag}>
              {m}
            </span>
          ))}
        </div>
      </div>
      <button className={styles.removeButton} onClick={() => onRemove(provider.name)}>
        <Trash2 size={14} />
        Remove
      </button>
    </div>
  );
}

// ── Timeout Selector Component ──────────────────────────────────────────────

interface TimeoutSelectorProps {
  currentMinutes: number;
  onChange: (minutes: number) => void;
}

export function TimeoutSelector({ currentMinutes, onChange }: TimeoutSelectorProps) {
  const options = [15, 30, 60, 120];

  return (
    <div className={styles.timeoutRow}>
      <div>
        <span className={styles.toggleLabel}>Session Timeout</span>
        <p className={styles.toggleDesc}>
          Automatically clear sessions after a period of inactivity.
        </p>
      </div>
      <div className={styles.timeoutOptions}>
        {options.map((mins) => (
          <button
            key={mins}
            className={`${styles.timeoutBtn} ${currentMinutes === mins ? styles.active : ""}`}
            onClick={() => onChange(mins)}
          >
            {mins}m
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Notification Toggle Component ───────────────────────────────────────────

interface NotificationToggleProps {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}

export function NotificationToggle({ enabled, onToggle }: NotificationToggleProps) {
  return (
    <div className={styles.toggleRow}>
      <div>
        <span className={styles.toggleLabel}>
          <Bell size={14} /> Notification on PII Detection
        </span>
        <p className={styles.toggleDesc}>
          Show an OS notification with Sanitize/Allow/Block action buttons when sensitive content
          is detected.
        </p>
      </div>
      <button
        className={`${styles.toggleSwitch} ${enabled ? styles.on : ""}`}
        onClick={() => onToggle(!enabled)}
      >
        <div className={styles.toggleKnob} />
      </button>
    </div>
  );
}

// ── Recognizer Grid Component ───────────────────────────────────────────────

interface RecognizerGridProps {
  recognizers: string[];
  activeRecognizers: string[];
  onToggle: (name: string) => void;
}

export function RecognizerGrid({ recognizers, activeRecognizers, onToggle }: RecognizerGridProps) {
  return (
    <div className={styles.recognizerGrid}>
      {recognizers.map((name) => (
        <button
          key={name}
          className={`${styles.recognizerBtn} ${activeRecognizers.includes(name) ? styles.active : ""}`}
          onClick={() => onToggle(name)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

// ── Clipboard Monitor Toggle Component ──────────────────────────────────────

interface ClipboardMonitorToggleProps {
  enabled: boolean;
  onToggle: () => Promise<void>;
}

export function ClipboardMonitorToggle({ enabled, onToggle }: ClipboardMonitorToggleProps) {
  const [toggling, setToggling] = useState(false);

  const handleClick = async () => {
    setToggling(true);
    try {
      await onToggle();
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className={styles.toggleRow}>
      <span>Monitor clipboard for PII</span>
      <button
        className={`${styles.toggleSwitch} ${enabled ? styles.on : ""} ${toggling ? styles.disabled : ""}`}
        onClick={handleClick}
        disabled={toggling}
      >
        <div className={styles.toggleKnob} />
      </button>
    </div>
  );
}
