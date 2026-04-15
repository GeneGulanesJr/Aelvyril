import { useState } from "react";
import {
  FileText,
  Download,
  Trash2,
} from "lucide-react";
import { useAuditLog } from "../hooks/useTauri";
import { AuditEntryCard } from "../components/AuditEntryCard";
import styles from "./AuditLog.module.css";

export function AuditLog() {
  const { entries, loading, clearAll, exportLog } = useAuditLog();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const handleExport = async (format: string) => {
    setExporting(true);
    try {
      const data = await exportLog(format);
      const blob = new Blob([data], {
        type: format === "csv" ? "text/csv" : "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `aelvyril-audit-log.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Export failed:", e);
    } finally {
      setExporting(false);
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedId(prev => prev === id ? null : id);
  };

  if (loading) {
    return (
      <div className={styles.page}>
        <div className={styles.header}>
          <h1 className={styles.title}>Audit Log</h1>
          <p className={styles.subtitle}>Loading entries…</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Audit Log</h1>
          <p className={styles.subtitle}>
            Record of all intercepted and sanitized requests —{" "}
            <strong>no raw PII values are ever stored</strong>
          </p>
        </div>
        <div className={styles.actions}>
          <button
            className={styles.exportBtn}
            onClick={() => handleExport("json")}
            disabled={exporting || entries.length === 0}
          >
            <Download size={14} />
            JSON
          </button>
          <button
            className={styles.exportBtn}
            onClick={() => handleExport("csv")}
            disabled={exporting || entries.length === 0}
          >
            <Download size={14} />
            CSV
          </button>
          {entries.length > 0 && (
            <button className={styles.clearBtn} onClick={clearAll}>
              <Trash2 size={14} />
              Clear All
            </button>
          )}
        </div>
      </div>

      {entries.length === 0 ? (
        <div className={styles.empty}>
          <FileText size={40} strokeWidth={1} />
          <h3>No Entries Yet</h3>
          <p>
            Audit logs will appear here once requests flow through the gateway.
            Each entry records what was detected and sanitized — without ever
            storing original sensitive values.
          </p>
        </div>
      ) : (
        <div className={styles.entryList}>
          {entries.map((entry) => (
            <AuditEntryCard
              key={entry.id}
              entry={entry}
              expanded={expandedId === entry.id}
              onToggle={() => toggleExpand(entry.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
