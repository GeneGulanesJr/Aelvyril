/**
 * Tauri API hooks for communicating with the Rust backend.
 * All commands are typed and wrapped in React hooks.
 */
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, useCallback } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GatewayStatus {
  active: boolean;
  port: number;
  has_key: boolean;
  provider_count: number;
  active_sessions: number;
  clipboard_monitoring: boolean;
  onboarding_complete: boolean;
  stats: AuditStats | null;
}

export interface AuditStats {
  total_requests: number;
  total_entities: number;
  entity_breakdown: [string, number][];
}

export interface Provider {
  id: string;
  name: string;
  base_url: string;
  models: string[];
}

export interface Session {
  id: string;
  created_at: string;
  last_activity: string;
  request_count: number;
  entities_detected: number;
  provider: string | null;
  model: string | null;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  session_id: string;
  provider: string;
  model: string;
  entity_types: [string, number][];
  total_entities: number;
  streaming: boolean;
  tokens_generated: string[];
}

export interface ListRule {
  id: string;
  pattern: string;
  label: string;
  created_at: string;
  enabled: boolean;
}

export interface AppSettings {
  launch_at_login: boolean;
  minimize_to_tray: boolean;
  show_notifications: boolean;
  clipboard_monitoring: boolean;
  session_timeout_minutes: number;
  gateway_port: number;
  enabled_recognizers: string[];
  confidence_threshold: number;
}

export interface DetectedTool {
  name: string;
  config_path: string;
  instructions: string;
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

export function useGatewayStatus() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<GatewayStatus>("get_gateway_status");
      setStatus(result);
    } catch (e) {
      console.error("Failed to get gateway status:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { status, loading, refresh };
}

export function useProviders() {
  const [providers, setProviders] = useState<Provider[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<Provider[]>("list_providers");
      setProviders(result);
    } catch (e) {
      console.error("Failed to list providers:", e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = useCallback(
    async (name: string, baseUrl: string, models: string[], apiKey: string) => {
      const result = await invoke<Provider>("add_provider", { name, baseUrl, models, apiKey });
      setProviders((prev) => [...prev, result]);
      return result;
    },
    [],
  );

  const fetchModels = useCallback(async (baseUrl: string, apiKey: string) => {
    return await invoke<string[]>("fetch_models", { baseUrl, apiKey });
  }, []);

  const remove = useCallback(async (name: string) => {
    await invoke("remove_provider", { name });
    setProviders((prev) => prev.filter((p) => p.name !== name));
  }, []);

  return { providers, add, fetchModels, remove, refresh };
}

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<Session[]>("list_sessions");
      setSessions(result);
    } catch (e) {
      console.error("Failed to list sessions:", e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const clear = useCallback(async (sessionId: string) => {
    await invoke("clear_session", { sessionId });
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
  }, []);

  return { sessions, clear, refresh };
}

export function useAuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<AuditEntry[]>("get_audit_log");
      setEntries(result);
    } catch (e) {
      console.error("Failed to get audit log:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const clearAll = useCallback(async () => {
    await invoke("clear_audit_log");
    setEntries([]);
  }, []);

  const exportLog = useCallback(async (format: string) => {
    return await invoke<string>("export_audit_log", { format });
  }, []);

  return { entries, loading, clearAll, exportLog, refresh };
}

export function useAuditStats() {
  const [stats, setStats] = useState<AuditStats | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<AuditStats>("get_audit_stats");
      setStats(result);
    } catch (e) {
      console.error("Failed to get audit stats:", e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { stats, refresh };
}

export function useGatewayKey() {
  const [key, setKey] = useState<string | null>(null);

  const generate = useCallback(async () => {
    const newKey = await invoke<string>("generate_gateway_key");
    setKey(newKey);
    return newKey;
  }, []);

  return { key, generate };
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<AppSettings>("get_settings");
      setSettings(result);
    } catch (e) {
      console.error("Failed to get settings:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const update = useCallback(async (newSettings: AppSettings) => {
    await invoke("update_settings", { settings: newSettings });
    setSettings(newSettings);
  }, []);

  return { settings, loading, update, refresh };
}

export function useAllowList() {
  const [rules, setRules] = useState<ListRule[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<ListRule[]>("list_allow_rules");
      setRules(result);
    } catch (e) {
      console.error("Failed to list allow rules:", e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = useCallback(async (pattern: string, label: string) => {
    const rule = await invoke<ListRule>("add_allow_rule", { pattern, label });
    setRules((prev) => [...prev, rule]);
    return rule;
  }, []);

  const remove = useCallback(async (id: string) => {
    await invoke("remove_allow_rule", { id });
    setRules((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const toggle = useCallback(async (id: string, enabled: boolean) => {
    await invoke("toggle_allow_rule", { id, enabled });
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, enabled } : r)));
  }, []);

  return { rules, add, remove, toggle, refresh };
}

export function useDenyList() {
  const [rules, setRules] = useState<ListRule[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<ListRule[]>("list_deny_rules");
      setRules(result);
    } catch (e) {
      console.error("Failed to list deny rules:", e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const add = useCallback(async (pattern: string, label: string) => {
    const rule = await invoke<ListRule>("add_deny_rule", { pattern, label });
    setRules((prev) => [...prev, rule]);
    return rule;
  }, []);

  const remove = useCallback(async (id: string) => {
    await invoke("remove_deny_rule", { id });
    setRules((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const toggle = useCallback(async (id: string, enabled: boolean) => {
    await invoke("toggle_deny_rule", { id, enabled });
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, enabled } : r)));
  }, []);

  return { rules, add, remove, toggle, refresh };
}

export function useClipboard() {
  const toggle = useCallback(async (enabled: boolean) => {
    await invoke("toggle_clipboard_monitor", { enabled });
  }, []);

  const scan = useCallback(async (content: string) => {
    return await invoke("scan_clipboard_content", { content });
  }, []);

  const respond = useCallback(async (response: string) => {
    return await invoke("respond_to_clipboard", { response });
  }, []);

  return { toggle, scan, respond };
}

export function useOnboarding() {
  const [status, setStatus] = useState<{
    complete: boolean;
    has_key: boolean;
    has_providers: boolean;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<{ complete: boolean; has_key: boolean; has_providers: boolean }>(
        "get_onboarding_status",
      );
      setStatus(result);
    } catch (e) {
      console.error("Failed to get onboarding status:", e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const complete = useCallback(async () => {
    await invoke("complete_onboarding");
    setStatus((prev) => (prev ? { ...prev, complete: true } : null));
  }, []);

  const detectTools = useCallback(async () => {
    const result = await invoke<{ tools: DetectedTool[] }>("detect_installed_tools");
    return result.tools;
  }, []);

  return { status, complete, detectTools, refresh };
}

// ── Security & Performance (Shot 3) ──────────────────────────────────────────

export interface LatencyStats {
  sample_count: number;
  avg_auth_ms: number;
  avg_pii_detect_ms: number;
  avg_pseudonymize_ms: number;
  avg_upstream_ms: number;
  avg_rehydrate_ms: number;
  avg_total_ms: number;
  p95_total_ms: number;
  p99_total_ms: number;
  max_total_ms: number;
  min_total_ms: number;
}

export interface RateLimitStatus {
  max_requests_per_minute: number;
  max_requests_per_hour: number;
  max_concurrent: number;
}

export interface KeyEvent {
  timestamp: string;
  key_id: string;
  action: string;
  detail: string;
}

export interface TlsStatus {
  enabled: boolean;
  files_exist: boolean;
  validity: {
    cert_exists: boolean;
    key_exists: boolean;
    cert_size_bytes: number;
    key_size_bytes: number;
  } | null;
}

export function useLatencyStats() {
  const [stats, setStats] = useState<LatencyStats | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<LatencyStats>("get_latency_stats");
      setStats(result);
    } catch (e) {
      console.error("Failed to get latency stats:", e);
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
      const result = await invoke<RateLimitStatus>("get_rate_limit_status");
      setStatus(result);
    } catch (e) {
      console.error("Failed to get rate limit status:", e);
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
      const result = await invoke<{ events: KeyEvent[] }>("get_key_audit_log");
      setEvents(result.events);
    } catch (e) {
      console.error("Failed to get key audit log:", e);
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
      const result = await invoke<TlsStatus>("get_tls_status");
      setStatus(result);
    } catch (e) {
      console.error("Failed to get TLS status:", e);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const generateCert = useCallback(async () => {
    await invoke("generate_tls_cert");
    await refresh();
  }, [refresh]);

  return { status, generateCert, refresh };
}
