import {
  Radio,
  Zap,
  Tag,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import type { AuditEntry } from "../hooks/useTauri";
import styles from "../pages/AuditLog.module.css";

interface AuditEntryCardProps {
  entry: AuditEntry;
  expanded: boolean;
  onToggle: () => void;
}

export function AuditEntryCard({ entry, expanded, onToggle }: AuditEntryCardProps) {
  return (
    <div
      className={`${styles.entryCard} ${expanded ? styles.expanded : ""}`}
    >
      <div className={styles.entryHeader} onClick={onToggle}>
        <div className={styles.entryLeft}>
          <span className={styles.entryTime}>
            {new Date(entry.timestamp).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
          <span className={styles.providerBadge}>{entry.provider}</span>
          <span className={styles.modelBadge}>{entry.model}</span>
        </div>
        <div className={styles.entryRight}>
          {entry.streaming && (
            <span className={styles.streamBadge}>
              <Radio size={12} />
              SSE
            </span>
          )}
          {entry.total_entities > 0 ? (
            <span className={styles.entityCount}>
              <Zap size={12} />
              {entry.total_entities}{" "}
              {entry.total_entities === 1 ? "entity" : "entities"}
            </span>
          ) : (
            <span className={styles.cleanBadge}>Clean</span>
          )}
          {expanded ? (
            <ChevronUp size={16} />
          ) : (
            <ChevronDown size={16} />
          )}
        </div>
      </div>

      {expanded && (
        <div className={styles.entryDetails}>
          {entry.entity_types.length > 0 && (
            <div className={styles.detailSection}>
              <h4>Detected Entity Types</h4>
              <div className={styles.entityTags}>
                {entry.entity_types.map(([type, count]) => (
                  <span key={type} className={styles.entityTag}>
                    {type}: {count}
                  </span>
                ))}
              </div>
            </div>
          )}
          {entry.tokens_generated.length > 0 && (
            <div className={styles.detailSection}>
              <h4>Tokens Generated</h4>
              <div className={styles.tokenTags}>
                {entry.tokens_generated.map((token) => (
                  <span key={token} className={styles.tokenTag}>
                    <Tag size={10} />
                    [{token}]
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className={styles.detailMeta}>
            <span>
              Session: <code>{entry.session_id.slice(0, 12)}…</code>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
