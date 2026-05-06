// tests/agents/ticket-agent/plan-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parsePlanResponse } from '../../../src/agents/ticket-agent/plan-parser.js';

describe('parsePlanResponse', () => {
  it('parses a valid response', () => {
    const raw = JSON.stringify({
      tickets: [
        { title: 'Add theme context', description: 'Create theme context', acceptance_criteria: ['Context exists'], dependencies: [], files: ['src/theme.tsx'], priority: 1 },
        { title: 'Build toggle', description: 'Build toggle component', acceptance_criteria: ['Toggle renders'], dependencies: ['#1'], files: ['src/Toggle.tsx', 'src/theme.tsx'], priority: 2 },
      ],
      concurrency: { max_parallel: 2, waves: [['#1'], ['#2']], conflict_groups: [] },
    });
    const result = parsePlanResponse(raw);
    expect(result.tickets).toHaveLength(2);
    expect(result.tickets[0].title).toBe('Add theme context');
    expect(result.plan.max_parallel).toBe(2);
  });

  it('rejects response with missing tickets', () => {
    expect(() => parsePlanResponse(JSON.stringify({ concurrency: { max_parallel: 1, waves: [[]], conflict_groups: [] } }))).toThrow('missing tickets');
  });

  it('rejects response with missing concurrency', () => {
    expect(() => parsePlanResponse(JSON.stringify({ tickets: [] }))).toThrow('missing concurrency');
  });

  it('rejects ticket without files', () => {
    const raw = JSON.stringify({
      tickets: [{ title: 'No files', description: '', acceptance_criteria: [], dependencies: [], files: [], priority: 1 }],
      concurrency: { max_parallel: 1, waves: [['#1']], conflict_groups: [] },
    });
    expect(() => parsePlanResponse(raw)).toThrow('must list files');
  });

  it('extracts JSON from markdown code fences', () => {
    const raw = 'Here is the plan:\n```json\n{"tickets":[{"title":"A","description":"B","acceptance_criteria":["C"],"dependencies":[],"files":["f.ts"],"priority":1}],"concurrency":{"max_parallel":1,"waves":[["#1"]],"conflict_groups":[]}}\n```';
    const result = parsePlanResponse(raw);
    expect(result.tickets).toHaveLength(1);
  });
});
