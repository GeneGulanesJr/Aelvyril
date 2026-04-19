import { useState } from "react";
import { Shield, AlertTriangle } from "lucide-react";
import { useAllowList, useDenyList } from "../../hooks/useTauri";
import { RuleRow } from "./RuleRow";
import styles from "../../pages/Settings.module.css";

interface NewRule {
  pattern: string;
  label: string;
}

const MAX_PATTERN_LENGTH = 500;
const MAX_LABEL_LENGTH = 200;

export function ListsSection() {
  const allow = useAllowList();
  const deny = useDenyList();
  const [newAllow, setNewAllow] = useState<NewRule>({ pattern: "", label: "" });
  const [newDeny, setNewDeny] = useState<NewRule>({ pattern: "", label: "" });
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const validateRegex = (pattern: string): { valid: boolean; error?: string } => {
    if (!pattern.trim()) {
      return { valid: false, error: "Pattern is required" };
    }
    if (pattern.length > MAX_PATTERN_LENGTH) {
      return { valid: false, error: `Pattern must be ${MAX_PATTERN_LENGTH} characters or less` };
    }
    try {
      new RegExp(pattern);
      return { valid: true };
    } catch (e) {
      return { valid: false, error: "Invalid regex pattern" };
    }
  };

  const sanitizeInput = (input: string): string => {
    return input.trim().replace(/[<>"'&]/g, '');
  };

  const handleAddAllow = async () => {
    setFieldErrors({});
    setError("");

    const patternValidation = validateRegex(newAllow.pattern);
    if (!patternValidation.valid) {
      setFieldErrors({ allowPattern: patternValidation.error! });
      return;
    }

    if (newAllow.label.length > MAX_LABEL_LENGTH) {
      setFieldErrors({ allowLabel: `Label must be ${MAX_LABEL_LENGTH} characters or less` });
      return;
    }

    try {
      const sanitizedPattern = sanitizeInput(newAllow.pattern);
      const sanitizedLabel = sanitizeInput(newAllow.label || newAllow.pattern);
      await allow.add(sanitizedPattern, sanitizedLabel);
      setNewAllow({ pattern: "", label: "" });
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };

  const handleAddDeny = async () => {
    setFieldErrors({});
    setError("");

    const patternValidation = validateRegex(newDeny.pattern);
    if (!patternValidation.valid) {
      setFieldErrors({ denyPattern: patternValidation.error! });
      return;
    }

    if (newDeny.label.length > MAX_LABEL_LENGTH) {
      setFieldErrors({ denyLabel: `Label must be ${MAX_LABEL_LENGTH} characters or less` });
      return;
    }

    try {
      const sanitizedPattern = sanitizeInput(newDeny.pattern);
      const sanitizedLabel = sanitizeInput(newDeny.label || newDeny.pattern);
      await deny.add(sanitizedPattern, sanitizedLabel);
      setNewDeny({ pattern: "", label: "" });
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className={styles.section}>
      {error && <p className={styles.error}>{error}</p>}

      {/* Allowlist */}
      <div className={styles.subSection}>
        <h3 className={styles.subTitle}>
          <Shield size={16} />
          Allowlist
          <span className={styles.subCount}>{allow.rules.length}</span>
        </h3>
        <p className={styles.subDesc}>
          Patterns to never flag — internal codenames, company domains, false positive tokens.
        </p>

        <div className={styles.addRuleRow}>
          <div className={styles.formGroup}>
            <input
              className={`${styles.input} ${fieldErrors.allowPattern ? styles.inputError : ''}`}
              placeholder="Regex pattern (e.g. example\\.com)"
              value={newAllow.pattern}
              onChange={(e) => setNewAllow({ ...newAllow, pattern: e.target.value })}
              maxLength={MAX_PATTERN_LENGTH}
            />
            {fieldErrors.allowPattern && <p className={styles.fieldError}>{fieldErrors.allowPattern}</p>}
          </div>
          <div className={styles.formGroup}>
            <input
              className={`${styles.input} ${fieldErrors.allowLabel ? styles.inputError : ''}`}
              placeholder="Label"
              value={newAllow.label}
              onChange={(e) => setNewAllow({ ...newAllow, label: e.target.value })}
              maxLength={MAX_LABEL_LENGTH}
            />
            {fieldErrors.allowLabel && <p className={styles.fieldError}>{fieldErrors.allowLabel}</p>}
          </div>
          <button className={styles.smallBtn} onClick={handleAddAllow}>
            Add
          </button>
        </div>

        {allow.rules.map((rule) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            onToggle={(enabled) => allow.toggle(rule.id, enabled)}
            onRemove={() => allow.remove(rule.id)}
          />
        ))}
      </div>

      {/* Denylist */}
      <div className={styles.subSection}>
        <h3 className={styles.subTitle}>
          <AlertTriangle size={16} />
          Denylist
          <span className={styles.subCount}>{deny.rules.length}</span>
        </h3>
        <p className={styles.subDesc}>
          Custom patterns always flagged — project-specific rules on top of built-in detection.
        </p>

        <div className={styles.addRuleRow}>
          <div className={styles.formGroup}>
            <input
              className={`${styles.input} ${fieldErrors.denyPattern ? styles.inputError : ''}`}
              placeholder="Regex pattern (e.g. PROJECT_\\w+)"
              value={newDeny.pattern}
              onChange={(e) => setNewDeny({ ...newDeny, pattern: e.target.value })}
              maxLength={MAX_PATTERN_LENGTH}
            />
            {fieldErrors.denyPattern && <p className={styles.fieldError}>{fieldErrors.denyPattern}</p>}
          </div>
          <div className={styles.formGroup}>
            <input
              className={`${styles.input} ${fieldErrors.denyLabel ? styles.inputError : ''}`}
              placeholder="Label"
              value={newDeny.label}
              onChange={(e) => setNewDeny({ ...newDeny, label: e.target.value })}
              maxLength={MAX_LABEL_LENGTH}
            />
            {fieldErrors.denyLabel && <p className={styles.fieldError}>{fieldErrors.denyLabel}</p>}
          </div>
          <button className={styles.smallBtn} onClick={handleAddDeny}>
            Add
          </button>
        </div>

        {deny.rules.map((rule) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            onToggle={(enabled) => deny.toggle(rule.id, enabled)}
            onRemove={() => deny.remove(rule.id)}
          />
        ))}
      </div>
    </div>
  );
}
