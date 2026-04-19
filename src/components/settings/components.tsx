import styles from "../../pages/Settings.module.css";

export function ToggleRow({
  label,
  desc,
  enabled,
  onToggle,
  icon,
}: {
  label: string;
  desc?: string;
  enabled: boolean;
  onToggle: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <div className={styles.toggleRow}>
      <div>
        <span className={styles.toggleLabel}>
          {icon} {label}
        </span>
        {desc && <p className={styles.toggleDesc}>{desc}</p>}
      </div>
      <button className={`${styles.toggleSwitch} ${enabled ? styles.on : ""}`} onClick={onToggle}>
        <div className={styles.toggleKnob} />
      </button>
    </div>
  );
}

export function TimeoutSelector({
  value,
  onChange,
}: {
  value: number;
  onChange: (minutes: number) => void;
}) {
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
            className={`${styles.timeoutBtn} ${value === mins ? styles.active : ""}`}
            onClick={() => onChange(mins)}
          >
            {mins}m
          </button>
        ))}
      </div>
    </div>
  );
}
