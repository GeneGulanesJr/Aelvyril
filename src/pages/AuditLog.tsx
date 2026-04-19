import { useState } from "react";
import { useAuditLog } from "../hooks/useTauri";
import { AuditEntryCard } from "../components/AuditEntryCard";
import { logger } from "../utils/logger";
import { AuditLogHeader, AuditLogEmpty, AuditLogLoading } from "./AuditLog.components";
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
      logger.error("Export failed", { component: "AuditLog", error: String(e) });
    } finally {
      setExporting(false);
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedId(prev => prev === id ? null : id);
  };

  if (loading) {
    return <AuditLogLoading />;
  }

  return (
    <div className={styles.page}>
      <AuditLogHeader
        entriesCount={entries.length}
        exporting={exporting}
        onExportJson={() => handleExport("json")}
        onExportCsv={() => handleExport("csv")}
        onClearAll={clearAll}
      />

      {entries.length === 0 ? (
        <AuditLogEmpty />
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
