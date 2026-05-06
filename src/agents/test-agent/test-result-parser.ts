import type { TestResult, TestFailure } from '../../types/common.js';

export function parseVitestOutput(output: string, testBranch: string): TestResult {
  if (!output || output.trim().length === 0) {
    return {
      passed: false,
      total: 0,
      passed_count: 0,
      failed_count: 0,
      failures: [{ test_name: '(unknown)', file: '', error_message: 'Test run produced no output — possible timeout', stack_trace: null }],
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

  const failures: TestFailure[] = [];
  const lines = output.split('\n');
  let currentFile = '';
  for (let i = 0; i < lines.length; i++) {
    const fileMatch = lines[i].match(/^\s*[✓✗]\s+(.+?)\s+\(\d+\s+tests?\)\s+\d+ms/);
    if (fileMatch) {
      currentFile = fileMatch[1].trim();
    }
    const failMatch = lines[i].match(/^\s*×\s+(.+)/);
    if (failMatch) {
      const testName = failMatch[1].trim();
      let error_message = '';
      if (i + 1 < lines.length) {
        const msgMatch = lines[i + 1].match(/^\s*→\s+(.+)/);
        if (msgMatch) {
          error_message = msgMatch[1].trim();
        }
      }
      failures.push({ test_name: testName, file: currentFile, error_message, stack_trace: null });
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
