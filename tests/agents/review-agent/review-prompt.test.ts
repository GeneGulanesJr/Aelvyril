import { describe, it, expect } from 'vitest';
import { buildReviewPrompt } from '../../../src/agents/review-agent/review-prompt.js';
import type { Ticket } from '../../../src/types/common.js';
import type { DiffResult } from '../../../src/agents/review-agent/diff-collector.js';

const baseTicket: Ticket = {
  id: '#1', session_id: 'test', title: 'Add dark mode toggle',
  description: 'Add a toggle component that switches between light and dark themes',
  acceptance_criteria: ['Toggle renders', 'Clicking toggles theme', 'Theme persists'],
  dependencies: [], files: ['src/Toggle.tsx', 'src/theme.tsx'], priority: 1,
  status: 'in_review', assigned_agent: null, test_results: null,
  review_notes: null, reject_count: 0, held_reason: null,
  git_branch: 'aelvyril/ticket-#1', cost_tokens: 0, cost_usd: 0,
  created_at: '', updated_at: '',
};

const baseDiff: DiffResult = {
  files: ['src/Toggle.tsx'],
  diff: 'diff --git a/src/Toggle.tsx\n+export function Toggle() { return <button>Toggle</button> }',
  stats: { additions: 5, deletions: 0 },
};

describe('buildReviewPrompt', () => {
  it('includes ticket title and acceptance criteria', () => {
    const prompt = buildReviewPrompt(baseTicket, baseDiff, []);
    expect(prompt).toContain('Add dark mode toggle');
    expect(prompt).toContain('Toggle renders');
    expect(prompt).toContain('Clicking toggles theme');
    expect(prompt).toContain('Theme persists');
  });

  it('includes the diff', () => {
    const prompt = buildReviewPrompt(baseTicket, baseDiff, []);
    expect(prompt).toContain('Toggle()');
    expect(prompt).toContain('<button>Toggle</button>');
  });

  it('includes changed files list', () => {
    const prompt = buildReviewPrompt(baseTicket, baseDiff, []);
    expect(prompt).toContain('src/Toggle.tsx');
  });

  it('includes diff stats', () => {
    const prompt = buildReviewPrompt(baseTicket, baseDiff, []);
    expect(prompt).toContain('5 additions');
  });

  it('includes memory context', () => {
    const prompt = buildReviewPrompt(baseTicket, baseDiff, [
      'Convention: Use PascalCase for React components',
      'Convention: All exports must be named (no default exports)',
    ]);
    expect(prompt).toContain('PascalCase');
    expect(prompt).toContain('named (no default exports)');
  });

  it('includes reject count for re-reviews', () => {
    const ticket = { ...baseTicket, reject_count: 2, review_notes: 'Missing error handling' };
    const prompt = buildReviewPrompt(ticket, baseDiff, []);
    expect(prompt).toContain('2');
    expect(prompt).toContain('Missing error handling');
  });

  it('instructs agent to output JSON ReviewDecision', () => {
    const prompt = buildReviewPrompt(baseTicket, baseDiff, []);
    expect(prompt).toContain('approved');
    expect(prompt).toContain('issues');
  });
});
