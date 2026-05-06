import type { Ticket, TicketStatus } from '../../types/common.js';
import type { StuckTicket } from './stuck-detector.js';

export interface ProgressReport {
  session_id: string;
  total_tickets: number;
  status: Record<TicketStatus, number>;
  alerts: { ticket: string; type: string; message: string }[];
  all_done: boolean;
  timestamp: string;
}

export function buildProgressReport(
  sessionId: string,
  tickets: Ticket[],
  stuckTickets: StuckTicket[]
): ProgressReport {
  const statusCounts: Record<string, number> = {
    backlog: 0, in_progress: 0, testing: 0, in_review: 0, done: 0, held: 0,
  };

  for (const ticket of tickets) {
    statusCounts[ticket.status] = (statusCounts[ticket.status] ?? 0) + 1;
  }

  const alerts = stuckTickets.map(stuck => ({
    ticket: stuck.ticket_id,
    type: stuck.reason === 'reject_threshold' ? 'escalate'
        : stuck.reason === 'reject_hard_stop' ? 'hard_stop'
        : stuck.reason === 'api_failure' ? 'api_failure'
        : 'stuck',
    message: `${stuck.status} for ${stuck.minutes_stuck}min — ${stuck.recommended_action}`,
  }));

  const nonHeldTotal = tickets.filter(t => t.status !== 'held').length;
  const doneCount = statusCounts.done ?? 0;

  return {
    session_id: sessionId,
    total_tickets: tickets.length,
    status: statusCounts as Record<TicketStatus, number>,
    alerts,
    all_done: nonHeldTotal > 0 && doneCount === nonHeldTotal,
    timestamp: new Date().toISOString(),
  };
}
