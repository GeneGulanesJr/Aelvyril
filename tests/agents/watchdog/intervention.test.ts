import { describe, it, expect } from 'vitest';
import { buildInterventionPrompt, parseInterventionResponse } from '../../../src/agents/watchdog/intervention.js';
import type { StuckTicket } from '../../../src/agents/watchdog/stuck-detector.js';

describe('buildInterventionPrompt', () => {
  it('includes the stuck ticket details', () => {
    const stuck: StuckTicket = {
      ticket_id: '#1',
      status: 'in_progress',
      reason: 'no_activity',
      minutes_stuck: 12,
      recommended_action: 'Check sub-agent status',
    };
    const prompt = buildInterventionPrompt(stuck, 'Add dark mode toggle', []);
    expect(prompt).toContain('#1');
    expect(prompt).toContain('in_progress');
    expect(prompt).toContain('12');
    expect(prompt).toContain('Add dark mode toggle');
  });

  it('includes board context', () => {
    const stuck: StuckTicket = {
      ticket_id: '#1', status: 'in_progress', reason: 'no_activity',
      minutes_stuck: 7, recommended_action: 'Retry',
    };
    const prompt = buildInterventionPrompt(stuck, 'Test', [
      'Board: 3 done, 1 in_progress, 2 backlog',
    ]);
    expect(prompt).toContain('3 done, 1 in_progress, 2 backlog');
  });

  it('includes reject history for reject_threshold cases', () => {
    const stuck: StuckTicket = {
      ticket_id: '#1', status: 'backlog', reason: 'reject_threshold',
      minutes_stuck: 0, recommended_action: 'Escalate to user',
    };
    const prompt = buildInterventionPrompt(stuck, 'Test', [], 3, 'Missing error handling');
    expect(prompt).toContain('3');
    expect(prompt).toContain('Missing error handling');
  });
});

  it('returns available actions in the prompt', () => {
    const stuck: StuckTicket = {
      ticket_id: '#5',
      status: 'in_progress',
      reason: 'no_activity',
      minutes_stuck: 10,
      recommended_action: 'Retry',
    };
    const prompt = buildInterventionPrompt(stuck, 'Fix auth bug', []);
    expect(prompt).toContain('retry');
    expect(prompt).toContain('re_scope');
    expect(prompt).toContain('escalate');
    expect(prompt).toContain('break_deadlock');
    expect(prompt).toContain('hold');
    expect(prompt).toContain('wait');
    expect(prompt).toContain('Available Actions');
  });

describe('parseInterventionResponse', () => {
  it('parses a valid intervention response', () => {
    const raw = JSON.stringify({
      action: 'retry',
      reasoning: 'Sub-agent likely crashed, ticket is straightforward',
      parameters: { max_retries: 1 },
    });
    const result = parseInterventionResponse(raw);
    expect(result.action).toBe('retry');
    expect(result.reasoning).toContain('crashed');
  });

  it('extracts from markdown fences', () => {
    const raw = '```json\n{"action":"escalate","reasoning":"3 rejects","parameters":{}}\n```';
    const result = parseInterventionResponse(raw);
    expect(result.action).toBe('escalate');
  });
});
