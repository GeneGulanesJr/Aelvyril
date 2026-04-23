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


// ── Orchestrator Types ────────────────────────────────────────────

export type OrchestratorPhase =
  | 'intake'
  | 'plan'
  | 'parse_plan'
  | 'select_subtask'
  | 'execute'
  | 'parse_execution'
  | 'validate'
  | 'complete_subtask'
  | 'replan'
  | 'done'
  | 'blocked';

export type TaskMode = 'planned' | 'direct';

export type TaskStatus =
  | 'intake'
  | 'planning'
  | 'executing'
  | 'blocked'
  | 'done'
  | 'cancelled';

export type SubtaskStatus =
  | 'pending'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'blocked';

export type ValidationStatus = 'pass' | 'fail';

export interface Task {
  id: string;
  user_request: string;
  mode: TaskMode;
  status: TaskStatus;
  created_at: number; // Unix epoch seconds (from chrono::serde::ts_seconds)
  completed_at: number | null;
}

export interface Subtask {
  id: string;
  title: string;
  description: string;
  allowed_files: string[];
  suggested_context_files: string[];
  constraints: string[];
  test_commands: string[];
  acceptance_criteria: string[];
  depends_on: string[];
  retry_count: number;
  status: SubtaskStatus;
}

export interface Plan {
  task_id: string;
  goal: string;
  assumptions: string[];
  subtasks: Subtask[];
  global_constraints: string[];
  completion_definition: string[];
}

export interface ExecutionResult {
  subtask_id: string;
  pi_completed: boolean;
  files_touched: string[];
  files_outside_scope: string[];
  pi_summary: string;
  tool_calls_made: number;
  turns_taken: number;
  needs_replan: boolean;
  replan_reason: string | null;
  git_diff_applied: boolean;
}

export interface ValidationResult {
  subtask_id: string;
  status: ValidationStatus;
  commands_run: string[];
  errors: string[];
  notes: string[];
}

export interface OrchestratorState {
  task: Task;
  plan: Plan | null;
  current_subtask: string | null;
  phase: OrchestratorPhase;
  retry_count: number;
  validation_retry_count: number;
  error_log: string[];
}

export interface OrchestratorSettings {
  enabled: boolean;
  planning_model: string;
  executor_model: string;
  max_subtask_retries: number;
  max_files_per_subtask: number;
  executor_timeout_secs: number;
  max_tool_calls: number;
  allowed_test_commands: string[];
}

// Matches Rust Default impl in types.rs. Single source of truth for the frontend.
export const DEFAULT_ORCHESTRATOR_SETTINGS: OrchestratorSettings = {
  enabled: false,
  planning_model: "",
  executor_model: "",
  max_subtask_retries: 2,
  max_files_per_subtask: 6,
  executor_timeout_secs: 600,
  max_tool_calls: 30,
  allowed_test_commands: [],
};

export interface TaskSummary {
  id: string;
  request: string;
  status: string;   // Raw from backend — normalize with normalizeStatus()
  phase: string;    // Raw from backend — normalize with normalizePhase()
  created_at: number; // Unix epoch seconds
  completed_at: number | null;
}

// ── Normalization Helpers ─────────────────────────────────────────
// Backend may return either PascalCase ("Executing") or snake_case ("executing")
// depending on endpoint. These helpers ensure consistent casing.

export function normalizeStatus(raw: string): TaskStatus {
  const lower = raw.toLowerCase();
  const valid: TaskStatus[] = ['intake', 'planning', 'executing', 'blocked', 'done', 'cancelled'];
  return (valid.includes(lower as TaskStatus) ? lower : 'intake') as TaskStatus;
}

export function normalizePhase(raw: string): OrchestratorPhase {
  const snake = raw
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
  const valid: OrchestratorPhase[] = [
    'intake', 'plan', 'parse_plan', 'select_subtask', 'execute',
    'parse_execution', 'validate', 'complete_subtask', 'replan', 'done', 'blocked',
  ];
  return (valid.includes(snake as OrchestratorPhase) ? snake : 'intake') as OrchestratorPhase;
}

