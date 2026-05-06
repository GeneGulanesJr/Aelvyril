import { describe, it, expect } from 'vitest';
import { buildTestPrompt } from '../../../src/agents/test-agent/test-prompt.js';
import type { Ticket } from '../../../src/types/common.js';

const baseTicket: Ticket = {
  id: '#1', session_id: 'test', title: 'Add dark mode toggle',
  description: 'Add a toggle that switches between light and dark themes',
  acceptance_criteria: ['Toggle renders', 'Clicking toggles theme', 'Theme persists in localStorage'],
  dependencies: [], files: ['src/Toggle.tsx', 'src/theme.tsx'], priority: 1,
  status: 'testing', assigned_agent: 'sub-1', test_results: null,
  review_notes: null, reject_count: 0, held_reason: null,
  git_branch: 'aelvyril/ticket-#1', cost_tokens: 0, cost_usd: 0,
  created_at: '', updated_at: '',
};

describe('buildTestPrompt', () => {
  it('includes ticket title and description', () => {
    const prompt = buildTestPrompt(baseTicket, []);
    expect(prompt).toContain('Add dark mode toggle');
    expect(prompt).toContain('Add a toggle that switches between light and dark themes');
  });

  it('includes all acceptance criteria', () => {
    const prompt = buildTestPrompt(baseTicket, []);
    expect(prompt).toContain('Toggle renders');
    expect(prompt).toContain('Clicking toggles theme');
    expect(prompt).toContain('Theme persists in localStorage');
  });

  it('includes files to test', () => {
    const prompt = buildTestPrompt(baseTicket, []);
    expect(prompt).toContain('src/Toggle.tsx');
    expect(prompt).toContain('src/theme.tsx');
  });

  it('includes git branch', () => {
    const prompt = buildTestPrompt(baseTicket, []);
    expect(prompt).toContain('aelvyril/ticket-#1');
  });

  it('includes memory context with test patterns', () => {
    const prompt = buildTestPrompt(baseTicket, [
      'Memory: Test pattern — use renderHook for custom hooks',
      'Memory: Tests use @testing-library/react',
    ]);
    expect(prompt).toContain('renderHook for custom hooks');
    expect(prompt).toContain('@testing-library/react');
  });

  it('instructs co-located test file placement', () => {
    const prompt = buildTestPrompt(baseTicket, []);
    expect(prompt).toContain('__tests__');
  });

  it('instructs agent to NOT run tests', () => {
    const prompt = buildTestPrompt(baseTicket, []);
    expect(prompt).toContain('DO NOT run');
  });
});
