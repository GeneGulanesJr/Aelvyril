import { describe, it, expect } from 'vitest';
import { buildProgressReport } from '../../../src/agents/watchdog/progress-reporter.js';
import type { Ticket, TicketStatus } from '../../../src/types/common.js';
import type { StuckTicket } from '../../../src/agents/watchdog/stuck-detector.js';

describe('buildProgressReport', () => {
  it('counts tickets by status', () => {
    const tickets: Ticket[] = [
      makeTicket('#1', 'done'),
      makeTicket('#2', 'done'),
      makeTicket('#3', 'in_progress'),
      makeTicket('#4', 'backlog'),
      makeTicket('#5', 'backlog'),
      makeTicket('#6', 'testing'),
      makeTicket('#7', 'in_review'),
    ];
    const report = buildProgressReport('ses_123', tickets, []);
    expect(report.total_tickets).toBe(7);
    expect(report.status.done).toBe(2);
    expect(report.status.in_progress).toBe(1);
    expect(report.status.backlog).toBe(2);
    expect(report.status.testing).toBe(1);
    expect(report.status.in_review).toBe(1);
  });

  it('includes alerts for stuck tickets', () => {
    const tickets: Ticket[] = [makeTicket('#1', 'in_progress')];
    const stuck: StuckTicket[] = [{
      ticket_id: '#1', status: 'in_progress', reason: 'no_activity',
      minutes_stuck: 12, recommended_action: 'Check sub-agent',
    }];
    const report = buildProgressReport('ses_123', tickets, stuck);
    expect(report.alerts).toHaveLength(1);
    expect(report.alerts[0].ticket).toBe('#1');
    expect(report.alerts[0].type).toBe('stuck');
    expect(report.alerts[0].message).toContain('12');
  });

  it('detects all-done state', () => {
    const tickets: Ticket[] = [
      makeTicket('#1', 'done'),
      makeTicket('#2', 'done'),
    ];
    const report = buildProgressReport('ses_123', tickets, []);
    expect(report.all_done).toBe(true);
  });

  it('counts held tickets separately', () => {
    const tickets: Ticket[] = [
      makeTicket('#1', 'done'),
      makeTicket('#2', 'held'),
    ];
    const report = buildProgressReport('ses_123', tickets, []);
    expect(report.status.held).toBe(1);
  });
});

function makeTicket(id: string, status: TicketStatus): Ticket {
  return {
    id, session_id: 'test', title: id, description: '',
    acceptance_criteria: [], dependencies: [], files: [], priority: 1,
    status, assigned_agent: null, test_results: null, review_notes: null,
    reject_count: 0, held_reason: null, git_branch: null,
    cost_tokens: 0, cost_usd: 0, created_at: '', updated_at: '',
  };
}
