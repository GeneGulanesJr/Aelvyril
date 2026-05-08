import type { Database } from '../db/database.js';
import type { CostReport, AgentType } from '../types/common.js';

const ALL_AGENT_TYPES: AgentType[] = ['supervisor', 'ticket', 'main', 'sub', 'test', 'review', 'watchdog', 'orchestrator', 'worker', 'scrutiny_validator', 'user_testing_validator', 'research_subagent'];

const SPEC_KEY_MAP: Record<AgentType, string> = {
  supervisor: 'supervisor_agent',
  ticket: 'ticket_agent',
  main: 'main_agent',
  sub: 'sub_agents',
  test: 'test_agent',
  review: 'review_agent',
  watchdog: 'watchdog_agent',
  orchestrator: 'orchestrator',
  worker: 'worker',
  scrutiny_validator: 'scrutiny_validator',
  user_testing_validator: 'user_testing_validator',
  research_subagent: 'research_subagent',
};

export class CostTracker {
  constructor(private db: Database) {}

  record(
    sessionId: string,
    agentType: string,
    ticketId: string | null,
    model: string,
    inputTokens: number,
    outputTokens: number,
    costUsd: number
  ): void {
    this.db.insertCostEntry({
      session_id: sessionId,
      agent_type: agentType as AgentType,
      ticket_id: ticketId,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: costUsd,
      timestamp: new Date().toISOString(),
    });
  }

  getReport(sessionId: string): CostReport {
    const rows = this.db.raw.prepare(`
      SELECT agent_type, ticket_id,
             SUM(input_tokens + output_tokens) as tokens,
             SUM(cost_usd) as cost
      FROM cost_entries
      WHERE session_id = ?
      GROUP BY agent_type, ticket_id
    `).all(sessionId) as { agent_type: string; ticket_id: string | null; tokens: number; cost: number }[];

    const byAgent: Record<string, { tokens: number; cost: number }> = {};
    const byTicket: Record<string, { tokens: number; cost: number }> = {};
    let totalTokens = 0;
    let totalCost = 0;

    for (const row of rows) {
      totalTokens += row.tokens;
      totalCost += row.cost;

      byAgent[row.agent_type] = byAgent[row.agent_type] ?? { tokens: 0, cost: 0 };
      byAgent[row.agent_type].tokens += row.tokens;
      byAgent[row.agent_type].cost += row.cost;

      if (row.ticket_id) {
        byTicket[row.ticket_id] = byTicket[row.ticket_id] ?? { tokens: 0, cost: 0 };
        byTicket[row.ticket_id].tokens += row.tokens;
        byTicket[row.ticket_id].cost += row.cost;
      }
    }

    const fullByAgent: CostReport['by_agent'] = {} as CostReport['by_agent'];
    for (const type of ALL_AGENT_TYPES) {
      fullByAgent[type] = byAgent[type] ?? { tokens: 0, cost: 0 };
    }

    return {
      session_id: sessionId,
      total_tokens: totalTokens,
      total_cost_usd: Math.round(totalCost * 10000) / 10000,
      by_agent: fullByAgent,
      by_ticket: byTicket,
    };
  }
}

export function toSpecFormat(report: CostReport): Record<string, unknown> {
  const byAgentSpec: Record<string, { tokens: number; cost: number }> = {};
  for (const [key, value] of Object.entries(report.by_agent)) {
    const specKey = SPEC_KEY_MAP[key as AgentType] ?? key;
    byAgentSpec[specKey] = value;
  }
  return {
    ...report,
    by_agent: byAgentSpec,
  };
}
