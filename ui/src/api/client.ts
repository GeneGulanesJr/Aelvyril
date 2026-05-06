const API_BASE = '/api';

export interface Session {
  id: string;
  repo_url: string;
  workspace_path: string;
  status: string;
  created_at: string;
}

export interface Ticket {
  id: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
  dependencies: string[];
  files: string[];
  priority: number;
  status: string;
  assigned_agent: string | null;
  test_results: unknown;
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

export interface CostReport {
  session_id: string;
  total_tokens: number;
  total_cost_usd: number;
  by_agent: Record<string, { tokens: number; cost: number }>;
  by_ticket: Record<string, { tokens: number; cost: number }>;
}

export interface Config {
  api_keys: Record<string, string>;
  models: Record<string, string>;
  max_parallel: number;
  watchdog_timeout_ms: number;
  branch_prefix: string;
}

export interface AuditEntry {
  session_id: string;
  agent_type: string;
  ticket_id: string | null;
  action: string;
  details: string | null;
  timestamp: string;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export const api = {
  getSessions: () => request<Session[]>('/sessions'),
  getSession: (id: string) => request<Session>(`/sessions/${id}`),
  createSession: (repoUrl: string) => request<Session>('/sessions', {
    method: 'POST',
    body: JSON.stringify({ repo_url: repoUrl }),
  }),
  deleteSession: (id: string) => fetch(`${API_BASE}/sessions/${id}`, { method: 'DELETE' }),
  getBoard: (sessionId: string) => request<BoardState>(`/sessions/${sessionId}/board`),
  getCost: (sessionId: string) => request<CostReport>(`/sessions/${sessionId}/cost`),
  getAudit: (sessionId: string) => request<AuditEntry[]>(`/sessions/${sessionId}/audit`),
  getConfig: () => request<Config>('/config'),
  updateConfig: (config: Partial<Config>) => request<Config>('/config', {
    method: 'PUT',
    body: JSON.stringify(config),
  }),
};
