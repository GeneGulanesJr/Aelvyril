/**
 * Extracted components for AuditLog.tsx to reduce nesting complexity
 */

import { FileText, Download, Trash2 } from "lucide-react";

// ── Audit Log Header Component ─────────────────────────────────────────────

interface AuditLogHeaderProps {
  entriesCount: number;
  exporting: boolean;
  onExportJson: () => void;
  onExportCsv: () => void;
  onClearAll: () => void;
}

export function AuditLogHeader({
  entriesCount,
  exporting,
  onExportJson,
  onExportCsv,
  onClearAll,
}: AuditLogHeaderProps) {
  return (
    <div className="header">
      <div>
        <h1 className="title">Audit Log</h1>
        <p className="subtitle">
          Record of all intercepted and sanitized requests —{" "}
          <strong>no raw PII values are ever stored</strong>
        </p>
      </div>
      <div className="actions">
        <button
          className="exportBtn"
          onClick={onExportJson}
          disabled={exporting || entriesCount === 0}
        >
          <Download size={14} />
          JSON
        </button>
        <button
          className="exportBtn"
          onClick={onExportCsv}
          disabled={exporting || entriesCount === 0}
        >
          <Download size={14} />
          CSV
        </button>
        {entriesCount > 0 && (
          <button className="clearBtn" onClick={onClearAll}>
            <Trash2 size={14} />
            Clear All
          </button>
        )}
      </div>
    </div>
  );
}

// ── Audit Log Empty State Component ────────────────────────────────────────

export function AuditLogEmpty() {
  return (
    <div className="empty">
      <FileText size={40} strokeWidth={1} />
      <h3>No Entries Yet</h3>
      <p>
        Audit logs will appear here once requests flow through the gateway.
        Each entry records what was detected and sanitized — without ever
        storing original sensitive values.
      </p>
    </div>
  );
}

// ── Loading State Component ────────────────────────────────────────────────

export function AuditLogLoading() {
  return (
    <div className="page">
      <div className="header">
        <h1 className="title">Audit Log</h1>
        <p className="subtitle">Loading entries…</p>
      </div>
    </div>
  );
}
