import styles from "./AuditLog.module.css";

export function AuditLog() {
  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Audit Log</h1>
        <p className={styles.subtitle}>Record of all intercepted and sanitized requests</p>
      </div>
      <div className={styles.empty}>
        <p>No entries yet. Audit logs will appear here once requests flow through the gateway.</p>
      </div>
    </div>
  );
}
