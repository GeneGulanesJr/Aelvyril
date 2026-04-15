import { Clock, Shield } from "lucide-react";
import { useSessions } from "../hooks/useTauri";
import { SessionCard } from "../components/SessionCard";
import styles from "./Sessions.module.css";

export function Sessions() {
  const { sessions, clear } = useSessions();

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Sessions</h1>
          <p className={styles.subtitle}>
            Active conversation sessions and their mapping state
          </p>
        </div>
        <div className={styles.count}>
          <Shield size={14} />
          <span>{sessions.length} active</span>
        </div>
      </div>

      {sessions.length === 0 ? (
        <div className={styles.empty}>
          <Clock size={40} strokeWidth={1} />
          <h3>No Active Sessions</h3>
          <p>
            Sessions are created automatically when requests flow through the
            gateway. Each session maintains its own PII mapping table for
            pseudonymization and rehydration.
          </p>
        </div>
      ) : (
        <div className={styles.sessionList}>
          {sessions.map((session) => (
            <SessionCard key={session.id} session={session} onClear={clear} />
          ))}
        </div>
      )}
    </div>
  );
}
