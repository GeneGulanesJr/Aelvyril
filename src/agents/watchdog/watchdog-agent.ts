import { detectStuckTickets, type StuckDetectionConfig, type StuckTicket } from './stuck-detector.js';
import { buildInterventionPrompt, parseInterventionResponse } from './intervention.js';
import { buildProgressReport, type ProgressReport } from './progress-reporter.js';
import type { BoardManager } from '../../board/board-manager.js';
import type { AgentPool } from '../agent-pool.js';
import type { Ticket } from '../../types/common.js';

export interface WatchdogConfig {
  pollIntervalMs: number;
  stallThresholdMs: number;
  progressStallMs: number;
  testingStallMs: number;
  reviewStallMs: number;
  rejectEscalationThreshold: number;
  rejectHardStopThreshold: number;
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  pollIntervalMs: 5000,
  stallThresholdMs: 300000,
  progressStallMs: 600000,
  testingStallMs: 600000,
  reviewStallMs: 300000,
  rejectEscalationThreshold: 3,
  rejectHardStopThreshold: 5,
};

export class WatchdogAgent {
  private interval: ReturnType<typeof setInterval> | null = null;
  private onProgress: ((report: ProgressReport) => void) | null = null;
  private onEscalate: ((ticketId: string, message: string) => void) | null = null;
  private onIntervention: ((stuck: StuckTicket, action: string) => void) | null = null;

  constructor(
    private pool: AgentPool,
    private board: BoardManager,
    private sessionId: string,
    private config: WatchdogConfig = DEFAULT_WATCHDOG_CONFIG
  ) {}

  setCallbacks(callbacks: {
    onProgress?: (report: ProgressReport) => void;
    onEscalate?: (ticketId: string, message: string) => void;
    onIntervention?: (stuck: StuckTicket, action: string) => void;
  }): void {
    this.onProgress = callbacks.onProgress ?? null;
    this.onEscalate = callbacks.onEscalate ?? null;
    this.onIntervention = callbacks.onIntervention ?? null;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async tick(): Promise<void> {
    const tickets = this.board.getTickets();

    const stuck = detectStuckTickets(tickets, {
      stallThresholdMs: this.config.stallThresholdMs,
      progressStallMs: this.config.progressStallMs,
      testingStallMs: this.config.testingStallMs,
      reviewStallMs: this.config.reviewStallMs,
      rejectEscalationThreshold: this.config.rejectEscalationThreshold,
      rejectHardStopThreshold: this.config.rejectHardStopThreshold,
    });

    const report = buildProgressReport(this.sessionId, tickets, stuck);
    this.onProgress?.(report);

    for (const stuckTicket of stuck) {
      await this.handleStuckTicket(stuckTicket, tickets);
    }
  }

  private async handleStuckTicket(stuck: StuckTicket, tickets: Ticket[]): Promise<void> {
    const ticket = tickets.find(t => t.id === stuck.ticket_id);
    if (!ticket) return;

    switch (stuck.reason) {
      case 'reject_hard_stop':
        this.onEscalate?.(stuck.ticket_id,
          `Ticket #${stuck.ticket_id} rejected ${ticket.reject_count} times. Hard stop. User guidance needed.`
        );
        this.board.hold(stuck.ticket_id, `Hard stop: rejected ${ticket.reject_count} times`);
        break;

      case 'reject_threshold':
        this.onEscalate?.(stuck.ticket_id,
          `Ticket #${stuck.ticket_id} rejected ${ticket.reject_count} times. Escalating for review.`
        );
        break;

      case 'no_activity':
        if (stuck.status === 'backlog' && stuck.minutes_stuck >= 5) {
          this.board.transition(stuck.ticket_id, 'in_progress');
          this.onIntervention?.(stuck, 'auto_nudge_to_in_progress');
        } else if (stuck.status === 'in_progress' && stuck.minutes_stuck >= 15) {
          this.onEscalate?.(stuck.ticket_id,
            `Ticket #${stuck.ticket_id} in progress for ${stuck.minutes_stuck} min. Agent may need restart.`
          );
        }
        break;

      case 'api_failure':
        this.board.hold(stuck.ticket_id, 'LLM API failure');
        this.onEscalate?.(stuck.ticket_id, 'LLM API failure — check your API key and provider status');
        break;

      case 'agent_crashed':
        this.board.transition(stuck.ticket_id, 'backlog');
        this.onIntervention?.(stuck, 'auto_retry_after_crash');
        break;
    }
  }
}
