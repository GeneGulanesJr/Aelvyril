// tests/agents/ticket-agent/prompt-builder.test.ts
import { describe, it, expect } from 'vitest';
import { buildTicketPrompt } from '../../../src/agents/ticket-agent/prompt-builder.js';

describe('buildTicketPrompt', () => {
  it('includes the user request', () => {
    const prompt = buildTicketPrompt('Add dark mode toggle to settings', []);
    expect(prompt).toContain('Add dark mode toggle to settings');
  });

  it('includes memory context when provided', () => {
    const prompt = buildTicketPrompt('Add dark mode', [
      'Memory: Theme system uses CSS variables in src/theme.tsx',
      'Memory: Settings page is at src/Settings.tsx',
    ]);
    expect(prompt).toContain('src/theme.tsx');
    expect(prompt).toContain('src/Settings.tsx');
  });

  it('instructs the agent to output JSON', () => {
    const prompt = buildTicketPrompt('Test task', []);
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('tickets');
    expect(prompt).toContain('concurrency');
  });
});
