import styles from "./Sessions.module.css";

export function Sessions() {
  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Sessions</h1>
        <p className={styles.subtitle}>Active conversation sessions and their mapping state</p>
      </div>
      <div className={styles.empty}>
        <p>No active sessions. Send a request through the gateway to create one.</p>
      </div>
    </div>
  );
}
