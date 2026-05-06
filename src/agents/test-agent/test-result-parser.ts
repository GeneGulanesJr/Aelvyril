import type { TestResult } from '../../types/common.js';

export function parseVitestOutput(output: string, testBranch: string): TestResult {
  if (!output || output.trim().length === 0) {
    return {
      passed: false,
      total: 0,
      passed_count: 0,
      failed_count: 0,
      failures: [{ test_name: '(unknown)', message: 'Test run produced no output — likely timed out' }],
      coverage_delta: null,
      duration_ms: 0,
      test_branch: testBranch,
      timestamp: new Date().toISOString(),
    };
  }

  const testsLine = output.match(/Tests\s+(\d+)\s+passed(?:,\s+(\d+)\s+failed)?\s+\((\d+)\)/);
  const passedCount = testsLine ? parseInt(testsLine[1], 10) : 0;
  const failedCount = testsLine && testsLine[2] ? parseInt(testsLine[2], 10) : 0;
  const total = testsLine ? parseInt(testsLine[3], 10) : 0;

  const failures: { test_name: string; message: string }[] = [];
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const failMatch = lines[i].match(/^\s*×\s+(.+)/);
    if (failMatch) {
      const testName = failMatch[1].trim();
      let message = '';
      if (i + 1 < lines.length) {
        const msgMatch = lines[i + 1].match(/^\s*→\s+(.+)/);
        if (msgMatch) {
          message = msgMatch[1].trim();
        }
      }
      failures.push({ test_name: testName, message });
    }
  }

  const durationMatch = output.match(/Duration\s+([\d.]+)s/);
  const durationMs = durationMatch ? Math.round(parseFloat(durationMatch[1]) * 1000) : 0;

  return {
    passed: failedCount === 0 && total > 0,
    total,
    passed_count: passedCount,
    failed_count: failedCount,
    failures,
    coverage_delta: null,
    duration_ms: durationMs,
    test_branch: testBranch,
    timestamp: new Date().toISOString(),
  };
}
