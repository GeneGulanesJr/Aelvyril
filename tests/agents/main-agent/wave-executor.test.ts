// tests/agents/main-agent/wave-executor.test.ts
import { describe, it, expect } from 'vitest';
import { getNextDispatchable } from '../../../src/agents/main-agent/wave-executor.js';
import type { Ticket, ConcurrencyPlan, TicketStatus } from '../../../src/types/common.js';

describe('getNextDispatchable', () => {
  it('returns first wave when no tickets are done', () => {
    const tickets: Ticket[] = [
      makeTicket('#1', 'backlog', []),
      makeTicket('#2', 'backlog', ['#1']),
      makeTicket('#3', 'backlog', []),
    ];
    const plan: ConcurrencyPlan = {
      max_parallel: 2,
      waves: [['#1', '#3'], ['#2']],
      conflict_groups: [],
    };
    const result = getNextDispatchable(tickets, plan);
    expect(result).toEqual(['#1', '#3']);
  });

  it('returns second wave when first wave is done', () => {
    const tickets: Ticket[] = [
      makeTicket('#1', 'done', []),
      makeTicket('#2', 'backlog', ['#1']),
      makeTicket('#3', 'done', []),
    ];
    const plan: ConcurrencyPlan = {
      max_parallel: 2,
      waves: [['#1', '#3'], ['#2']],
      conflict_groups: [],
    };
    const result = getNextDispatchable(tickets, plan);
    expect(result).toEqual(['#2']);
  });

  it('returns empty when all are done', () => {
    const tickets: Ticket[] = [
      makeTicket('#1', 'done', []),
      makeTicket('#2', 'done', ['#1']),
    ];
    const plan: ConcurrencyPlan = {
      max_parallel: 2,
      waves: [['#1'], ['#2']],
      conflict_groups: [],
    };
    const result = getNextDispatchable(tickets, plan);
    expect(result).toEqual([]);
  });

  it('respects max_parallel limit', () => {
    const tickets: Ticket[] = [
      makeTicket('#1', 'backlog', []),
      makeTicket('#2', 'backlog', []),
      makeTicket('#3', 'backlog', []),
    ];
    const plan: ConcurrencyPlan = {
      max_parallel: 2,
      waves: [['#1', '#2', '#3']],
      conflict_groups: [],
    };
    const result = getNextDispatchable(tickets, plan, 1);
    expect(result).toHaveLength(1);
  });
});

function makeTicket(id: string, status: TicketStatus, deps: string[]): Ticket {
  return {
    id, session_id: 'test', title: id, description: '',
    acceptance_criteria: [], dependencies: deps, files: [`file_${id}.ts`],
    priority: 1, status, assigned_agent: null, test_results: null,
    review_notes: null, reject_count: 0, held_reason: null,
    git_branch: null, cost_tokens: 0, cost_usd: 0,
    created_at: '', updated_at: '',
  };
}
