import { useCallback, useEffect, useState } from "react";
import { logInvokeError, tauriInvoke } from "./invoke";
import type { KeyEvent, LatencyStats, RateLimitStatus, TlsStatus } from "./types";

export function useLatencyStats() {
  const [stats, setStats] = useState<LatencyStats | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await tauriInvoke<LatencyStats>("get_latency_stats");
      setStats(result);
    } catch (e) {
      logInvokeError("useLatencyStats", "Failed to get latency stats", e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { stats, refresh };
}

export function useRateLimitStatus() {
  const [status, setStatus] = useState<RateLimitStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await tauriInvoke<RateLimitStatus>("get_rate_limit_status");
      setStatus(result);
    } catch (e) {
      logInvokeError("useRateLimitStatus", "Failed to get rate limit status", e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { status, refresh };
}

export function useKeyAuditLog() {
  const [events, setEvents] = useState<KeyEvent[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await tauriInvoke<{ events: KeyEvent[] }>("get_key_audit_log");
      setEvents(result.events);
    } catch (e) {
      logInvokeError("useKeyAuditLog", "Failed to get key audit log", e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { events, refresh };
}

export function useTlsStatus() {
  const [status, setStatus] = useState<TlsStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await tauriInvoke<TlsStatus>("get_tls_status");
      setStatus(result);
    } catch (e) {
      logInvokeError("useTlsStatus", "Failed to get TLS status", e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const generateCert = useCallback(async () => {
    await tauriInvoke("generate_tls_cert");
    await refresh();
  }, [refresh]);

  return { status, generateCert, refresh };
}

