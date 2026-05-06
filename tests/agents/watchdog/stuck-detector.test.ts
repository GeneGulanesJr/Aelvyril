import { describe, it, expect } from 'vitest';
import { detectStuckTickets } from '../../../src/agents/watchdog/stuck-detector.js';
import type { Ticket, TicketStatus } from '../../../src/types/common.js';

describe('detectStuckTickets', () => {
  it('returns empty when all tickets have recent activity', () => {
    const now = new Date().toISOString();
    const tickets = [makeTicket('#1', 'in_progress', now, 0)];
    expect(detectStuckTickets(tickets, { stallThresholdMs: 300000 })).toEqual([]);
  });

  it('detects ticket stalled with no activity for 5+ minutes', () => {
    const sixMinAgo = new Date(Date.now() - 360000).toISOString();
    const tickets = [makeTicket('#1', 'in_progress', sixMinAgo, 0)];
    const stuck = detectStuckTickets(tickets, { stallThresholdMs: 300000, progressStallMs: 300000 });
    expect(stuck).toHaveLength(1);
    expect(stuck[0].ticket_id).toBe('#1');
    expect(stuck[0].reason).toBe('no_activity');
    expect(stuck[0].minutes_stuck).toBeGreaterThanOrEqual(5);
  });

  it('ignores done tickets', () => {
    const old = new Date(Date.now() - 600000).toISOString();
    const tickets = [makeTicket('#1', 'done', old, 0)];
    expect(detectStuckTickets(tickets, { stallThresholdMs: 300000 })).toEqual([]);
  });

  it('ignores held tickets', () => {
    const old = new Date(Date.now() - 600000).toISOString();
    const tickets = [makeTicket('#1', 'held', old, 0)];
    expect(detectStuckTickets(tickets, { stallThresholdMs: 300000 })).toEqual([]);
  });

  it('detects backlog ticket with no blockers after threshold', () => {
    const sixMinAgo = new Date(Date.now() - 360000).toISOString();
    const tickets = [makeTicket('#1', 'backlog', sixMinAgo, 0, [])];
    const stuck = detectStuckTickets(tickets, { stallThresholdMs: 300000 });
    expect(stuck).toHaveLength(1);
    expect(stuck[0].ticket_id).toBe('#1');
  });

  it('does not flag blocked backlog tickets', () => {
    const sixMinAgo = new Date(Date.now() - 360000).toISOString();
    const tickets = [
      makeTicket('#1', 'in_progress', sixMinAgo, 0),
      makeTicket('#2', 'backlog', sixMinAgo, 0, ['#1']),
    ];
    const stuck = detectStuckTickets(tickets, { stallThresholdMs: 300000 });
    const backlogStuck = stuck.filter(s => s.ticket_id === '#2');
    expect(backlogStuck).toHaveLength(0);
  });

  it('detects reject threshold escalation at 3 rejects', () => {
    const now = new Date().toISOString();
    const tickets = [makeTicket('#1', 'backlog', now, 3)];
    const stuck = detectStuckTickets(tickets, { stallThresholdMs: 300000, rejectEscalationThreshold: 3 });
    expect(stuck).toHaveLength(1);
    expect(stuck[0].reason).toBe('reject_threshold');
    expect(stuck[0].recommended_action).toContain('Escalate');
  });

  it('detects hard stop at 5 rejects', () => {
    const now = new Date().toISOString();
    const tickets = [makeTicket('#1', 'backlog', now, 5)];
    const stuck = detectStuckTickets(tickets, { stallThresholdMs: 300000, rejectHardStopThreshold: 5 });
    expect(stuck).toHaveLength(1);
    expect(stuck[0].reason).toBe('reject_hard_stop');
    expect(stuck[0].recommended_action).toContain('stop');
  });
});

function makeTicket(
  id: string, status: TicketStatus, updatedAt: string,
  rejectCount = 0, deps: string[] = []
): Ticket {
  return {
    id, session_id: 'test', title: `Ticket ${id}`, description: '',
    acceptance_criteria: [], dependencies: deps, files: [], priority: 1,
    status, assigned_agent: status === 'in_progress' ? 'sub-1' : null,
    test_results: null, review_notes: null, reject_count: rejectCount,
    held_reason: null, git_branch: `aelvyril/ticket-${id}`,
    cost_tokens: 0, cost_usd: 0, created_at: '', updated_at: updatedAt,
  };
}
