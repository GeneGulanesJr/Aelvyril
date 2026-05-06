import type { SupervisorIntent } from './supervisor.types.js';

export function classifyIntent(message: string): SupervisorIntent {
  const lower = message.toLowerCase().trim();

  if (/^(stop|cancel|abort|kill\s+all)/.test(lower)) {
    return { type: 'cancel' };
  }

  if (/^(status|what'?s?\s+(the\s+)?status|how'?s?\s+it\s+going|progress)/.test(lower)) {
    return { type: 'status_check' };
  }

  const redirectMatch = lower.match(/(?:for|change|redirect)\s+(#\d+)\s+(?:to|do|into)\s+(.+)/i)
    ?? lower.match(/(#\d+)\s+(?:actually|instead)\s+(.+)/i);
  if (redirectMatch) {
    return {
      type: 'redirect',
      ticket_id: redirectMatch[1],
      content: redirectMatch[2],
    };
  }

  return { type: 'new_request', content: message };
}
