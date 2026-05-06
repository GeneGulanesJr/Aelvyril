import { describe, it, expect } from 'vitest';
import { parseReviewDecision } from '../../../src/agents/review-agent/review-decision-parser.js';

describe('parseReviewDecision', () => {
  it('parses an approval', () => {
    const raw = JSON.stringify({
      approved: true,
      summary: 'Looks good',
      notes: 'All criteria met, clean code',
      issues: [],
    });
    const decision = parseReviewDecision(raw);
    expect(decision.approved).toBe(true);
    expect(decision.summary).toBe('Looks good');
    expect(decision.issues).toEqual([]);
  });

  it('parses a rejection with issues', () => {
    const raw = JSON.stringify({
      approved: false,
      summary: 'Needs error handling',
      notes: 'Missing try-catch in the API call',
      issues: [
        { file: 'src/api.ts', line: 42, severity: 'critical', message: 'No error handling for network failures' },
        { file: 'src/Toggle.tsx', severity: 'suggestion', message: 'Consider adding aria-label' },
      ],
    });
    const decision = parseReviewDecision(raw);
    expect(decision.approved).toBe(false);
    expect(decision.issues).toHaveLength(2);
    expect(decision.issues[0].severity).toBe('critical');
    expect(decision.issues[1].line).toBeUndefined();
  });

  it('extracts JSON from markdown code fences', () => {
    const raw = 'Here is my review:\n```json\n{"approved":true,"summary":"OK","notes":"","issues":[]}\n```';
    const decision = parseReviewDecision(raw);
    expect(decision.approved).toBe(true);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseReviewDecision('not json')).toThrow('Invalid JSON');
  });

  it('throws when approved field is missing', () => {
    expect(() => parseReviewDecision(JSON.stringify({ summary: 'oops' }))).toThrow('approved');
  });

  it('defaults missing optional fields', () => {
    const decision = parseReviewDecision(JSON.stringify({ approved: true }));
    expect(decision.summary).toBe('');
    expect(decision.notes).toBe('');
    expect(decision.issues).toEqual([]);
  });
});
