import { describe, it, expect } from 'vitest';
import { buildSubAgentPrompt } from '../../../src/agents/sub-agent/sub-agent-prompt.js';
import type { Ticket } from '../../../src/types/common.js';

const baseTicket: Ticket = {
  id: '#1', session_id: 'test', title: 'Add dark mode toggle',
  description: 'Add a toggle component that switches between light and dark themes',
  acceptance_criteria: ['Toggle component renders', 'Clicking toggle switches theme', 'Theme persists'],
  dependencies: [], files: ['src/Toggle.tsx', 'src/theme.tsx'], priority: 1,
  status: 'in_progress', assigned_agent: 'sub-1', test_results: null,
  review_notes: null, reject_count: 0, held_reason: null,
  git_branch: 'aelvyril/ticket-#1', cost_tokens: 0, cost_usd: 0,
  created_at: '', updated_at: '',
};

describe('buildSubAgentPrompt', () => {
  it('includes ticket title and description', () => {
    const prompt = buildSubAgentPrompt(baseTicket, []);
    expect(prompt).toContain('Add dark mode toggle');
    expect(prompt).toContain('Add a toggle component');
  });

  it('includes acceptance criteria', () => {
    const prompt = buildSubAgentPrompt(baseTicket, []);
    expect(prompt).toContain('Toggle component renders');
    expect(prompt).toContain('Theme persists');
  });

  it('includes files to touch', () => {
    const prompt = buildSubAgentPrompt(baseTicket, []);
    expect(prompt).toContain('src/Toggle.tsx');
    expect(prompt).toContain('src/theme.tsx');
  });

  it('includes memory context', () => {
    const prompt = buildSubAgentPrompt(baseTicket, ['Memory: Uses CSS variables for theming']);
    expect(prompt).toContain('CSS variables');
  });

  it('includes git branch info', () => {
    const prompt = buildSubAgentPrompt(baseTicket, []);
    expect(prompt).toContain('aelvyril/ticket-#1');
  });
});
