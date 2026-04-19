import { useCallback, useEffect, useState } from "react";
import { logInvokeError, tauriInvoke } from "./invoke";
import type { AuditEntry, AuditStats } from "./types";

export function useAuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await tauriInvoke<AuditEntry[]>("get_audit_log");
      setEntries(result);
    } catch (e) {
      logInvokeError("useAuditLog", "Failed to get audit log", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const clearAll = useCallback(async () => {
    await tauriInvoke("clear_audit_log");
    setEntries([]);
  }, []);

  const exportLog = useCallback(async (format: string) => {
    return await tauriInvoke<string>("export_audit_log", { format });
  }, []);

  return { entries, loading, clearAll, exportLog, refresh };
}

export function useAuditStats() {
  const [stats, setStats] = useState<AuditStats | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await tauriInvoke<AuditStats>("get_audit_stats");
      setStats(result);
    } catch (e) {
      logInvokeError("useAuditStats", "Failed to get audit stats", e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { stats, refresh };
}

