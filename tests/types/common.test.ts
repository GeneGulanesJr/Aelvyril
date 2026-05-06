import { describe, it, expect } from 'vitest';
import type {
  AgentType,
  TicketStatus,
  SessionStatus,
  CostEntry,
  AuditEntry,
} from '../../src/types/common.js';

describe('common types', () => {
  it('AgentType has all 7 agent roles', () => {
    const agents: AgentType[] = [
      'supervisor', 'ticket', 'main', 'sub', 'test', 'review', 'watchdog'
    ];
    expect(agents).toHaveLength(7);
  });

  it('TicketStatus has all 6 states', () => {
    const statuses: TicketStatus[] = [
      'backlog', 'in_progress', 'testing', 'in_review', 'done', 'held'
    ];
    expect(statuses).toHaveLength(6);
  });

  it('SessionStatus has all states', () => {
    const statuses: SessionStatus[] = [
      'active', 'paused', 'completed', 'crashed'
    ];
    expect(statuses).toHaveLength(4);
  });
});
