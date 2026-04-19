import { X } from "lucide-react";
import styles from "../../pages/Settings.module.css";

export interface Rule {
  id: string;
  pattern: string;
  label: string;
  enabled: boolean;
}

export interface RuleRowProps {
  rule: Rule;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}

export function RuleRow({ rule, onToggle, onRemove }: RuleRowProps) {
  return (
    <div className={`${styles.ruleRow} ${!rule.enabled ? styles.disabled : ""}`}>
      <label className={styles.toggleLabel}>
        <input
          type="checkbox"
          checked={rule.enabled}
          onChange={(e) => onToggle(e.target.checked)}
          className={styles.checkbox}
        />
      </label>
      <div className={styles.ruleInfo}>
        <span className={styles.rulePattern}>{rule.pattern}</span>
        <span className={styles.ruleLabel}>{rule.label}</span>
      </div>
      <button className={styles.removeSmallBtn} onClick={onRemove}>
        <X size={12} />
      </button>
    </div>
  );
}
