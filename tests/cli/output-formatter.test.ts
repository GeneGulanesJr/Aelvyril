import { describe, it, expect } from 'vitest';
import {
  formatSupervisorResponse,
  formatTicketEvent,
  formatAgentActivity,
  formatCostUpdate,
  formatProgressReport,
  formatError,
  stripAnsi,
} from '../../src/cli/output-formatter.js';

describe('Output formatters', () => {
  describe('formatSupervisorResponse', () => {
    it('formats with green prefix', () => {
      const result = formatSupervisorResponse('Creating 4 tickets for your request');
      expect(stripAnsi(result)).toContain('Creating 4 tickets for your request');
      expect(result).toContain('\x1b[32m');
    });
  });

  describe('formatTicketEvent', () => {
    it('formats ticket transition', () => {
      const result = formatTicketEvent('#1', 'in_progress', 'backlog');
      expect(stripAnsi(result)).toContain('#1');
      expect(stripAnsi(result)).toContain('in_progress');
      expect(stripAnsi(result)).toContain('backlog');
    });

    it('formats ticket creation', () => {
      const result = formatTicketEvent('#3', 'backlog', null);
      expect(stripAnsi(result)).toContain('#3');
      expect(stripAnsi(result)).toContain('backlog');
    });

    it('formats held state with yellow', () => {
      const result = formatTicketEvent('#2', 'held', 'in_progress');
      expect(result).toContain('\x1b[33m');
    });
  });

  describe('formatAgentActivity', () => {
    it('formats agent activity with agent name', () => {
      const result = formatAgentActivity('MAIN_AGENT', 'Dispatched #1 → sub-agent-a');
      expect(stripAnsi(result)).toContain('MAIN_AGENT');
      expect(stripAnsi(result)).toContain('Dispatched #1 → sub-agent-a');
    });

    it('uses blue color for agent name', () => {
      const result = formatAgentActivity('TEST_AGENT', 'Running tests for #1');
      expect(result).toContain('\x1b[34m');
    });
  });

  describe('formatCostUpdate', () => {
    it('formats cost with dim gray', () => {
      const result = formatCostUpdate(1500, 0.08);
      expect(stripAnsi(result)).toContain('1,500 tokens');
      expect(stripAnsi(result)).toContain('$0.0800');
      expect(result).toContain('\x1b[2m');
    });
  });

  describe('formatProgressReport', () => {
    it('formats progress as a summary line', () => {
      const result = formatProgressReport({
        total_tickets: 5,
        status: { done: 2, in_progress: 1, testing: 0, in_review: 1, backlog: 1, held: 0 },
        alerts: [],
      });
      expect(stripAnsi(result)).toContain('5 tickets');
      expect(stripAnsi(result)).toContain('2 done');
      expect(stripAnsi(result)).toContain('1 in_progress');
    });

    it('shows alerts when present', () => {
      const result = formatProgressReport({
        total_tickets: 3,
        status: { done: 1, in_progress: 1, testing: 0, in_review: 0, backlog: 1, held: 0 },
        alerts: [{ ticket: '#2', type: 'stuck', message: 'In Progress for 12min' }],
      });
      expect(stripAnsi(result)).toContain('#2');
      expect(stripAnsi(result)).toContain('stuck');
    });
  });

  describe('formatError', () => {
    it('formats errors in red', () => {
      const result = formatError('Connection refused');
      expect(stripAnsi(result)).toContain('Connection refused');
      expect(result).toContain('\x1b[31m');
    });
  });
});
