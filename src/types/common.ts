// src/types/common.ts
export type AgentType =
  | 'supervisor' | 'ticket' | 'main' | 'sub' | 'test' | 'review' | 'watchdog'
  | 'orchestrator' | 'worker' | 'scrutiny_validator' | 'user_testing_validator' | 'research_subagent';

export type TicketStatus = 'backlog' | 'in_progress' | 'testing' | 'in_review' | 'done' | 'held';

export type SessionStatus = 'active' | 'paused' | 'completed' | 'crashed';

export interface CostEntry {
  session_id: string;
  agent_type: AgentType;
  ticket_id: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  timestamp: string;
}

export interface AuditEntry {
  session_id: string;
  agent_type: AgentType;
  ticket_id: string | null;
  action: string;
  details: string | null;
  timestamp: string;
}

export interface TestFailure {
  test_name: string;
  file: string;
  error_message: string;
  stack_trace: string | null;
}

export interface TestResult {
  passed: boolean;
  total: number;
  passed_count: number;
  failed_count: number;
  failures: TestFailure[];
  coverage_delta: number | null;
  duration_ms: number;
  test_branch: string;
  timestamp: string;
}

export interface Ticket {
  id: string;
  session_id: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
  dependencies: string[];
  files: string[];
  priority: number;
  status: TicketStatus;
  assigned_agent: string | null;
  test_results: TestResult | null;
  review_notes: string | null;
  reject_count: number;
  held_reason: string | null;
  git_branch: string | null;
  cost_tokens: number;
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

export interface ConcurrencyPlan {
  tickets: Ticket[];
  max_parallel: number;
  waves: string[][];
  conflict_groups: string[][];
}

export interface BoardState {
  session_id: string;
  tickets: Ticket[];
  plan: ConcurrencyPlan;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  repo_url: string;
  repo_path: string;
  branch: string;
  status: SessionStatus;
  memory_db_path: string;
  created_at: string;
  updated_at: string;
}

export interface CostReport {
  session_id: string;
  total_tokens: number;
  total_cost_usd: number;
  by_agent: Record<AgentType, { tokens: number; cost: number }>;
  by_ticket: Record<string, { tokens: number; cost: number }>;
}

export interface AgentModelConfig {
  supervisor: string;
  ticket: string;
  main: string;
  sub: string;
  test: string;
  review: string;
  watchdog: string;
}

export interface AelvyrilConfig {
  port: number;
  api_keys: Record<string, string>;
  models: AgentModelConfig;
  max_parallel: number;
  watchdog: {
    heartbeat_interval_ms: number;
    stuck_threshold_ms: number;
  };
  git: {
    branch_prefix: string;
    auto_merge: boolean;
  };
  db_path: string;
  memory_db_dir: string;
}
