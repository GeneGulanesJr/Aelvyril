import { Trash2, Clock, Zap, Shield } from "lucide-react";
import { formatDate, timeSince } from "../utils/formatDate";
import styles from "../pages/Sessions.module.css";

interface Session {
  id: string;
  created_at: string;
  last_activity: string;
  request_count: number;
  entities_detected: number;
  provider?: string | null;
}

interface SessionCardProps {
  session: Session;
  onClear: (id: string) => void;
}

export function SessionCard({ session, onClear }: SessionCardProps) {
  return (
    <div className={styles.sessionCard}>
      <div className={styles.sessionHeader}>
        <div className={styles.sessionId}>
          <code>{session.id.slice(0, 12)}…</code>
        </div>
        <div className={styles.sessionMeta}>
          <span className={styles.metaItem}>
            <Clock size={12} />
            {timeSince(session.last_activity)}
          </span>
          {session.provider && (
            <span className={styles.providerTag}>
              {session.provider}
            </span>
          )}
        </div>
      </div>

      <div className={styles.sessionStats}>
        <div className={styles.stat}>
          <Zap size={14} />
          <span>{session.request_count} requests</span>
        </div>
        <div className={styles.stat}>
          <Shield size={14} />
          <span>{session.entities_detected} entities caught</span>
        </div>
      </div>

      <div className={styles.sessionFooter}>
        <span className={styles.createdAt}>
          Created {formatDate(session.created_at)}
        </span>
        <button
          className={styles.clearBtn}
          onClick={() => onClear(session.id)}
        >
          <Trash2 size={12} />
          Clear
        </button>
      </div>
    </div>
  );
}
