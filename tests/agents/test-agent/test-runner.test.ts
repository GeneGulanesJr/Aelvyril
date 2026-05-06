import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { runTests } from '../../../src/agents/test-agent/test-runner.js';
import { execFileSync } from 'child_process';

const mockExecFileSync = execFileSync as unknown as ReturnType<typeof vi.fn>;

describe('runTests', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it('returns success for passing tests', async () => {
    mockExecFileSync.mockReturnValue(
      'Test Files  2 passed (2)\nTests  5 passed (5)\nDuration  1.23s\n'
    );
    const result = await runTests('/workspace');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain('5 passed');
  });

  it('returns failure for failing tests', async () => {
    const error: any = new Error('Command failed');
    error.stdout = 'Tests  3 passed, 2 failed (5)\n';
    error.stderr = '';
    error.status = 1;
    mockExecFileSync.mockImplementation(() => {
      throw error;
    });

    const result = await runTests('/workspace');
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('2 failed');
    expect(result.timedOut).toBe(false);
  });

  it('returns timedOut when process is killed', async () => {
    const error: any = new Error('Process killed');
    error.killed = true;
    mockExecFileSync.mockImplementation(() => {
      throw error;
    });

    const result = await runTests('/workspace');
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(-1);
    expect(result.output).toBe('');
  });

  it('uses default config values', async () => {
    mockExecFileSync.mockReturnValue('Tests  1 passed (1)\n');
    await runTests('/workspace');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'npx',
      ['vitest', 'run'],
      expect.objectContaining({
        cwd: '/workspace',
        timeout: 120000,
      })
    );
  });

  it('uses custom config values', async () => {
    mockExecFileSync.mockReturnValue('Tests  1 passed (1)\n');
    await runTests('/workspace', {
      command: 'yarn',
      args: ['test', '--ci'],
      timeoutMs: 5000,
    });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'yarn',
      ['test', '--ci'],
      expect.objectContaining({
        cwd: '/workspace',
        timeout: 5000,
      })
    );
  });

  it('handles command not found error', async () => {
    const error: any = new Error('spawn ENOENT');
    error.code = 'ENOENT';
    error.stdout = '';
    error.stderr = 'command not found';
    error.status = 127;
    mockExecFileSync.mockImplementation(() => {
      throw error;
    });

    const result = await runTests('/workspace');
    expect(result.exitCode).toBe(127);
    expect(result.output).toContain('command not found');
    expect(result.timedOut).toBe(false);
  });
});
