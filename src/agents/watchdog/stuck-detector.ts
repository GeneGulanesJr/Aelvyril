import type { Ticket, TicketStatus } from '../../types/common.js';

export interface StuckTicket {
  ticket_id: string;
  status: TicketStatus;
  reason: 'no_activity' | 'reject_threshold' | 'reject_hard_stop' | 'agent_crashed' | 'api_failure';
  minutes_stuck: number;
  recommended_action: string;
}

export interface StuckDetectionConfig {
  stallThresholdMs: number;
  progressStallMs?: number;
  testingStallMs?: number;
  reviewStallMs?: number;
  rejectEscalationThreshold?: number;
  rejectHardStopThreshold?: number;
}

export function detectStuckTickets(
  tickets: Ticket[],
  config: StuckDetectionConfig
): StuckTicket[] {
  const stuck: StuckTicket[] = [];
  const now = Date.now();
  const ticketMap = new Map(tickets.map(t => [t.id, t]));

  const progressStall = config.progressStallMs ?? 600000;
  const testingStall = config.testingStallMs ?? 600000;
  const reviewStall = config.reviewStallMs ?? 300000;
  const rejectEscalation = config.rejectEscalationThreshold ?? 3;
  const rejectHardStop = config.rejectHardStopThreshold ?? 5;

  for (const ticket of tickets) {
    if (ticket.status === 'done' || ticket.status === 'held') continue;

    const minutesStuck = (now - new Date(ticket.updated_at).getTime()) / 60000;

    if (ticket.reject_count >= rejectHardStop) {
      stuck.push({
        ticket_id: ticket.id,
        status: ticket.status,
        reason: 'reject_hard_stop',
        minutes_stuck: Math.round(minutesStuck),
        recommended_action: `Hard stop — ticket rejected ${ticket.reject_count} times. Ask user for guidance.`,
      });
      continue;
    }

    if (ticket.reject_count >= rejectEscalation) {
      stuck.push({
        ticket_id: ticket.id,
        status: ticket.status,
        reason: 'reject_threshold',
        minutes_stuck: Math.round(minutesStuck),
        recommended_action: `Escalate to user — ticket rejected ${ticket.reject_count} times.`,
      });
      continue;
    }

    const msSinceUpdate = now - new Date(ticket.updated_at).getTime();
    let threshold: number;

    switch (ticket.status) {
      case 'in_progress':
        threshold = progressStall;
        break;
      case 'testing':
        threshold = testingStall;
        break;
      case 'in_review':
        threshold = reviewStall;
        break;
      case 'backlog':
        const hasBlockers = ticket.dependencies.some(depId => {
          const dep = ticketMap.get(depId);
          return dep && dep.status !== 'done';
        });
        if (hasBlockers) continue;
        threshold = config.stallThresholdMs;
        break;
      default:
        continue;
    }

    if (msSinceUpdate >= threshold) {
      stuck.push({
        ticket_id: ticket.id,
        status: ticket.status,
        reason: 'no_activity',
        minutes_stuck: Math.round(minutesStuck),
        recommended_action: getRecommendedAction(ticket.status, minutesStuck),
      });
    }
  }

  return stuck;
}

function getRecommendedAction(status: TicketStatus, minutesStuck: number): string {
  switch (status) {
    case 'backlog':
      return 'Move to In Progress and nudge Main Agent.';
    case 'in_progress':
      if (minutesStuck >= 15) return 'Kill sub-agent, re-scope ticket.';
      if (minutesStuck >= 10) return 'Check sub-agent status — retry if crashed.';
      return 'Wait — sub-agent may still be working.';
    case 'testing':
      return 'Check Test Agent — re-spawn if dead.';
    case 'in_review':
      return 'Check Review Agent — re-assign if dead.';
    default:
      return 'Investigate.';
  }
}
