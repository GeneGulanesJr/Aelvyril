import { describe, it, expect } from 'vitest';
import { parseVitestOutput } from '../../../src/agents/test-agent/test-result-parser.js';

describe('parseVitestOutput', () => {
  it('parses fully passing test output', () => {
    const output = `
 ✓ src/Toggle.test.tsx (2 tests) 45ms
 ✓ src/theme.test.tsx (3 tests) 23ms

 Test Files  2 passed (2)
      Tests  5 passed (5)
   Start at  14:23:01
   Duration  3.12s
`;
    const result = parseVitestOutput(output, 'aelvyril/ticket-#1');
    expect(result.passed).toBe(true);
    expect(result.total).toBe(5);
    expect(result.passed_count).toBe(5);
    expect(result.failed_count).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.test_branch).toBe('aelvyril/ticket-#1');
    expect(result.duration_ms).toBe(3120);
    expect(result.timestamp).toBeDefined();
  });

  it('parses failing test output with failure details', () => {
    const output = `
 ✓ src/theme.test.tsx (3 tests) 23ms
 ✗ src/Toggle.test.tsx (2 tests) 45ms
   × should toggle theme on click
     → expected "dark" received "light"
   ✓ should render toggle button

 Test Files  1 passed, 1 failed (2)
      Tests  4 passed, 1 failed (5)
   Duration  1.50s
`;
    const result = parseVitestOutput(output, 'aelvyril/ticket-#2');
    expect(result.passed).toBe(false);
    expect(result.total).toBe(5);
    expect(result.passed_count).toBe(4);
    expect(result.failed_count).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].test_name).toBe('should toggle theme on click');
    expect(result.failures[0].error_message).toContain('expected "dark" received "light"');
  });

  it('handles empty/timeout output', () => {
    const result = parseVitestOutput('', 'aelvyril/ticket-#4');
    expect(result.passed).toBe(false);
    expect(result.total).toBe(0);
    expect(result.failed_count).toBe(0);
    expect(result.failures[0]?.error_message).toContain('timeout');
  });

  it('extracts duration', () => {
    const output = `
 ✓ src/test.ts (1 test) 10ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Duration  2.45s
`;
    const result = parseVitestOutput(output, 'aelvyril/ticket-#5');
    expect(result.duration_ms).toBe(2450);
  });

  it('defaults duration to 0 when not found', () => {
    const output = `
 ✓ src/test.ts (1 test) 10ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
`;
    const result = parseVitestOutput(output, 'aelvyril/ticket-#6');
    expect(result.duration_ms).toBe(0);
  });

  it('parses multiple failures', () => {
    const output = `
 ✗ src/api.test.ts (3 tests) 100ms
   × should return 200
     → expected 404 received 200
   × should return JSON
     → expected "text/html" received "application/json"
   ✓ should have body

 Test Files  0 passed, 1 failed (1)
      Tests  1 passed, 2 failed (3)
`;
    const result = parseVitestOutput(output, 'aelvyril/ticket-#3');
    expect(result.passed).toBe(false);
    expect(result.failed_count).toBe(2);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0].test_name).toBe('should return 200');
    expect(result.failures[0].file).toBe('src/api.test.ts');
    expect(result.failures[0].error_message).toBe('expected 404 received 200');
    expect(result.failures[1].test_name).toBe('should return JSON');
    expect(result.failures[1].error_message).toBe('expected "text/html" received "application/json"');
  });
});
