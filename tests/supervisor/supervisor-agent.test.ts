import { describe, it, expect } from 'vitest';
import { classifyIntent } from '../../src/supervisor/supervisor-agent.js';

describe('classifyIntent', () => {
  it('detects cancel intent', () => {
    expect(classifyIntent('stop everything')).toEqual({ type: 'cancel' });
    expect(classifyIntent('cancel')).toEqual({ type: 'cancel' });
  });

  it('detects status check intent', () => {
    expect(classifyIntent('status')).toEqual({ type: 'status_check' });
    expect(classifyIntent('what\'s the status')).toEqual({ type: 'status_check' });
    expect(classifyIntent('how\'s it going')).toEqual({ type: 'status_check' });
  });

  it('detects redirect intent with ticket ID', () => {
    const result = classifyIntent('actually for #3 do X instead');
    expect(result.type).toBe('redirect');
    if (result.type === 'redirect') {
      expect(result.ticket_id).toBe('#3');
      expect(result.content.toLowerCase()).toContain('x instead');
    }
  });

  it('defaults to new request for everything else', () => {
    expect(classifyIntent('Add dark mode to settings')).toEqual({
      type: 'new_request',
      content: 'Add dark mode to settings',
    });
  });
});
