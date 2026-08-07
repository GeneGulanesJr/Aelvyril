import { useState, useEffect } from "react";
import { Shield, AlertOctagon, Info } from "lucide-react";
import { useSettings } from "../../hooks/tauri/settings";
import { tauriInvoke } from "../../hooks/tauri/invoke";
import styles from "../../pages/Settings.module.css";

type PolicyAction = "warn" | "block";

interface PolicyRule {
  text: string;
  action: PolicyAction;
  enabled: boolean;
}

const MAX_RULE_LENGTH = 500;

export function PolicySection() {
  const { settings, update } = useSettings();
  const [rules, setRules] = useState<PolicyRule[]>([]);
  const [newText, setNewText] = useState("");
  const [newAction, setNewAction] = useState<PolicyAction>("warn");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  // Hydrate from settings on mount / change
  useEffect(() => {
    if (settings) {
      setRules(settings.policy_rules ?? []);
    }
  }, [settings]);

  const persist = async (next: PolicyRule[]) => {
    setRules(next);
    setSaved(false);
    if (!settings) return;
    try {
      await update({ ...settings, policy_rules: next });
      setSaved(true);
      setError("");
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleAdd = async () => {
    setError("");
    const trimmed = newText.trim();
    if (!trimmed) {
      setError("Rule text is required");
      return;
    }
    if (trimmed.length > MAX_RULE_LENGTH) {
      setError(`Rule text must be ${MAX_RULE_LENGTH} characters or less`);
      return;
    }
    await persist([...rules, { text: trimmed, action: newAction, enabled: true }]);
    setNewText("");
    setNewAction("warn");
  };

  const handleToggle = async (idx: number, enabled: boolean) => {
    const next = rules.map((r, i) => (i === idx ? { ...r, enabled } : r));
    await persist(next);
  };

  const handleActionChange = async (idx: number, action: PolicyAction) => {
    const next = rules.map((r, i) => (i === idx ? { ...r, action } : r));
    await persist(next);
  };

  const handleRemove = async (idx: number) => {
    await persist(rules.filter((_, i) => i !== idx));
  };

  const handleLoadDefaults = async () => {
    setError("");
    try {
      const defaults = await tauriInvoke<PolicyRule[]>("get_default_policy_rules");
      const existing = new Set(rules.map((r) => r.text.toLowerCase()));
      const missing = defaults.filter((d) => !existing.has(d.text.toLowerCase()));
      if (missing.length === 0) {
        console.log("Starter rules already present");
        return;
      }
      await persist([...rules, ...missing.map((m) => ({ ...m, enabled: true }))]);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className={styles.section}>
      <p className={styles.sectionDescription}>
        Zero-shot content-policy linting using the Liquid LFM2.5-Encoder-350M-Policy-Linter.
        Rules are checked against every user message before forwarding to upstream.
        <code>warn</code> audits the violation and forwards the request.
        <code>block</code> rejects the request with a 400.
      </p>

      <div className={styles.liquidBanner}>
        <Info size={14} />
        <span>
          Requires the Python sidecar with{" "}
          <code>AELVYRIL_LIQUID_POLICY_ENABLED=1</code>. Models are auto-downloaded
          from Hugging Face on first use.
        </span>
      </div>

      {error && <p className={styles.error}>{error}</p>}
      {saved && <p className={styles.success}>Saved</p>}

      <div className={styles.subSection}>
        <h3 className={styles.subTitle}>
          <Shield size={16} />
          Policy rules
          <span className={styles.subCount}>{rules.length}</span>
        </h3>

        <div className={styles.addRuleRow}>
          <div className={styles.formGroup} style={{ flex: 1 }}>
            <input
              className={styles.input}
              placeholder='e.g. "Flag direct mentions of competitor companies."'
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              maxLength={MAX_RULE_LENGTH}
            />
          </div>
          <div className={styles.formGroup}>
            <select
              className={styles.input}
              value={newAction}
              onChange={(e) => setNewAction(e.target.value as PolicyAction)}
            >
              <option value="warn">warn</option>
              <option value="block">block</option>
            </select>
          </div>
          <button className={styles.smallBtn} onClick={handleAdd}>
            Add
          </button>
          <button className={styles.smallBtn} onClick={handleLoadDefaults}>
            Load starter pack
          </button>
        </div>

        {rules.length === 0 && (
          <p className={styles.emptyHint}>
            No rules yet. Add a free-text rule above to start linting.
          </p>
        )}

        {rules.map((rule, idx) => (
          <div key={`${rule.text}-${idx}`} className={styles.ruleRow}>
            <label className={styles.toggleLabel}>
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(e) => handleToggle(idx, e.target.checked)}
              />
            </label>
            <span className={styles.ruleText}>{rule.text}</span>
            <select
              className={`${styles.input} ${styles.actionSelect}`}
              value={rule.action}
              onChange={(e) =>
                handleActionChange(idx, e.target.value as PolicyAction)
              }
            >
              <option value="warn">warn</option>
              <option value="block">block</option>
            </select>
            {rule.action === "block" && (
              <AlertOctagon size={14} className={styles.blockIcon} />
            )}
            <button
              className={styles.smallBtn}
              onClick={() => handleRemove(idx)}
              aria-label="Remove rule"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}