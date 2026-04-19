export interface GatewayStatus {
  active: boolean;
  port: number;
  bind_address: string;
  url: string;
  health_endpoint: string;
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
  gateway_bind_address?: string;
  enabled_recognizers: string[];
  confidence_threshold: number;
  rate_limit_max_requests_per_minute: number;
  rate_limit_max_requests_per_hour: number;
  rate_limit_max_concurrent_requests: number;
}

export interface DetectedTool {
  name: string;
  config_path: string;
  instructions: string;
}

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

// ── Token Usage Statistics ──────────────────────────────────────────────────

export interface GlobalTokenStats {
  total_tokens_in: number;
  total_tokens_out: number;
  total_tokens_cached: number;
  total_tokens_truncated: number;
  total_cost_cents: number;
  total_cost_unavailable: boolean;
  total_calls: number;
  total_sessions: number;
  active_sessions: number;
  avg_duration_ms: number;
  success_rate: number;
  truncation_rate: number;
  cost_estimate_usd: string;
  baseline_method: string;
  suggestion: string;
}

export interface SessionTokenStats {
  session_id: string;
  tenant_id: string;
  status: "active" | "closed" | "orphaned";
  duration_seconds: number;
  tokens_in_system: number;
  tokens_in_user: number;
  tokens_in_cached: number;
  tokens_out: number;
  tokens_truncated: number;
  cost_estimate_cents: number;
  cost_unavailable: boolean;
  truncation_count: number;
  retry_count: number;
  partial_count: number;
  call_count: number;
  avg_duration_ms: number;
  p50_duration_ms: number;
  p99_duration_ms: number;
  tokens_saved_vs_full_file_read: number;
  baseline_method: string;
  baseline_disclaimer: string;
  first_event: string | null;
  last_event: string | null;
}

export interface ToolTokenStats {
  tool: string;
  tokens_in_system: number;
  tokens_in_user: number;
  tokens_in_cached: number;
  tokens_out: number;
  tokens_truncated: number;
  cost_estimate_cents: number;
  call_count: number;
  success_rate: number;
  retry_rate: number;
  partial_rate: number;
  avg_duration_ms: number;
  p50_duration_ms: number;
  p99_duration_ms: number;
  pct_of_total: number;
}

export interface ModelTokenStats {
  model_id: string;
  tokens_in_system: number;
  tokens_in_user: number;
  tokens_in_cached: number;
  tokens_out: number;
  cost_estimate_cents: number;
  cost_unavailable: boolean;
  call_count: number;
  pricing_as_of: string;
  avg_duration_ms: number;
  p50_duration_ms: number;
  p99_duration_ms: number;
}

export interface DailyTokenTrend {
  date: string;
  tokens_in_system: number;
  tokens_in_user: number;
  tokens_in_cached: number;
  tokens_out: number;
  tokens_truncated: number;
  cost_estimate_cents: number;
  call_count: number;
  success_count: number;
  retry_count: number;
  partial_count: number;
  avg_duration_ms: number;
  truncation_rate: number;
}

export interface EfficiencyMetrics {
  context_to_output_ratio: number | null;
  system_overhead_pct: number;
  cost_per_successful_task_cents: number | null;
  tokens_saved_pct: number;
  baseline_method: string;
  baseline_disclaimer: string;
  truncation_rate: number;
  suggestion: string;
}

export interface TokenCountSourceBreakdown {
  api_reported: number;
  estimated: number;
  unavailable: number;
}

export interface TokenStatsMeta {
  schema_version: number;
  token_count_sources: TokenCountSourceBreakdown;
  token_count_reconciliation_issue: boolean;
  incomplete_data: boolean;
  orphaned: boolean;
  access_level: string;
}

export interface TokenStatsResponse {
  session: SessionTokenStats;
  by_tool: ToolTokenStats[];
  by_model: ModelTokenStats[];
  daily_trends: DailyTokenTrend[];
  efficiency: EfficiencyMetrics;
  meta: TokenStatsMeta;
}

