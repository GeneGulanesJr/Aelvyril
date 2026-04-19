import { useState } from "react";
import { Plus, Trash2, Bell } from "lucide-react";
import { useProviders, useSettings } from "../../hooks/useTauri";
import styles from "../../pages/Settings.module.css";

interface NewProvider {
  name: string;
  baseUrl: string;
  models: string;
  apiKey: string;
}

export function ProvidersSection() {
  const { providers, add, remove } = useProviders();
  const { settings, update } = useSettings();
  const [showAdd, setShowAdd] = useState(false);
  const [newProvider, setNewProvider] = useState<NewProvider>({
    name: "",
    baseUrl: "",
    models: "",
    apiKey: "",
  });
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const validateUrl = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  };

  const sanitizeInput = (input: string): string => {
    return input.trim().replace(/[<>"'&]/g, '');
  };

  const validateProviderName = (name: string): boolean => {
    return /^[a-zA-Z0-9\s\-_]+$/.test(name) && name.length > 0 && name.length <= 100;
  };

  const validateApiKey = (apiKey: string): boolean => {
    return apiKey.length >= 10 && apiKey.length <= 500;
  };

  const handleAdd = async () => {
    setFieldErrors({});
    setError("");

    const errors: Record<string, string> = {};

    if (!newProvider.name) {
      errors.name = "Provider name is required";
    } else if (!validateProviderName(newProvider.name)) {
      errors.name = "Invalid provider name. Use only letters, numbers, spaces, hyphens, and underscores (1-100 characters)";
    }

    if (!newProvider.baseUrl) {
      errors.baseUrl = "Base URL is required";
    } else if (!validateUrl(newProvider.baseUrl)) {
      errors.baseUrl = "Invalid URL. Must start with http:// or https://";
    }

    if (!newProvider.apiKey) {
      errors.apiKey = "API key is required";
    } else if (!validateApiKey(newProvider.apiKey)) {
      errors.apiKey = "Invalid API key. Must be between 10 and 500 characters";
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setError("Please fix the validation errors below");
      return;
    }

    try {
      const sanitizedName = sanitizeInput(newProvider.name);
      const sanitizedBaseUrl = sanitizeInput(newProvider.baseUrl);
      const sanitizedApiKey = sanitizeInput(newProvider.apiKey);
      const models = newProvider.models
        .split(",")
        .map((m) => sanitizeInput(m))
        .filter(Boolean)
        .slice(0, 50);

      if (models.length === 0 && newProvider.models.trim()) {
        errors.models = "No valid model names provided";
        setFieldErrors(errors);
        return;
      }

      await add(sanitizedName, sanitizedBaseUrl, models, sanitizedApiKey);
      setNewProvider({ name: "", baseUrl: "", models: "", apiKey: "" });
      setShowAdd(false);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Upstream Providers</h2>
        <button className={styles.addButton} onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? (
            "Cancel"
          ) : (
            <>
              <Plus size={14} /> Add Provider
            </>
          )}
        </button>
      </div>

      {showAdd && (
        <div className={styles.addForm}>
          <div className={styles.formRow}>
            <div className={styles.formGroup}>
              <label className={styles.label}>Provider Name</label>
              <input
                className={`${styles.input} ${fieldErrors.name ? styles.inputError : ''}`}
                placeholder="OpenAI"
                value={newProvider.name}
                onChange={(e) => setNewProvider({ ...newProvider, name: e.target.value })}
                maxLength={100}
              />
              {fieldErrors.name && <p className={styles.fieldError}>{fieldErrors.name}</p>}
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label}>Base URL</label>
              <input
                className={`${styles.input} ${fieldErrors.baseUrl ? styles.inputError : ''}`}
                placeholder="https://api.openai.com/v1"
                value={newProvider.baseUrl}
                onChange={(e) => setNewProvider({ ...newProvider, baseUrl: e.target.value })}
                maxLength={500}
              />
              {fieldErrors.baseUrl && <p className={styles.fieldError}>{fieldErrors.baseUrl}</p>}
            </div>
          </div>
          <div className={styles.formRow}>
            <div className={styles.formGroup}>
              <label className={styles.label}>Models (comma-separated)</label>
              <input
                className={`${styles.input} ${fieldErrors.models ? styles.inputError : ''}`}
                placeholder="gpt-4o, gpt-4o-mini"
                value={newProvider.models}
                onChange={(e) => setNewProvider({ ...newProvider, models: e.target.value })}
                maxLength={1000}
              />
              {fieldErrors.models && <p className={styles.fieldError}>{fieldErrors.models}</p>}
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label}>API Key</label>
              <input
                className={`${styles.input} ${fieldErrors.apiKey ? styles.inputError : ''}`}
                type="password"
                placeholder="sk-..."
                value={newProvider.apiKey}
                onChange={(e) => setNewProvider({ ...newProvider, apiKey: e.target.value })}
                maxLength={500}
              />
              {fieldErrors.apiKey && <p className={styles.fieldError}>{fieldErrors.apiKey}</p>}
            </div>
          </div>
          {error && <p className={styles.error}>{error}</p>}
          <button className={styles.saveButton} onClick={handleAdd}>
            Save Provider
          </button>
        </div>
      )}

      {providers.length === 0 && !showAdd && (
        <div className={styles.empty}>
          No upstream providers configured. Add one to start routing requests.
        </div>
      )}

      {providers.map((provider) => (
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
          <button className={styles.removeButton} onClick={() => remove(provider.name)}>
            <Trash2 size={14} />
            Remove
          </button>
        </div>
      ))}

      <div className={styles.timeoutRow}>
        <div>
          <span className={styles.toggleLabel}>Session Timeout</span>
          <p className={styles.toggleDesc}>
            Automatically clear sessions after a period of inactivity.
          </p>
        </div>
        <div className={styles.timeoutOptions}>
          {[15, 30, 60, 120].map((mins) => (
            <button
              key={mins}
              className={`${styles.timeoutBtn} ${settings?.session_timeout_minutes === mins ? styles.active : ""}`}
              onClick={() => update({ ...settings!, session_timeout_minutes: mins })}
            >
              {mins}m
            </button>
          ))}
        </div>
      </div>

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
          className={`${styles.toggleSwitch} ${settings?.show_notifications ? styles.on : ""}`}
          onClick={() => update({ ...settings!, show_notifications: !settings?.show_notifications })}
        >
          <div className={styles.toggleKnob} />
        </button>
      </div>
    </div>
  );
}
