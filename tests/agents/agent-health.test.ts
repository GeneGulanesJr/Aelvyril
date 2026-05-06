import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentHealthMonitor } from '../../src/agents/agent-health.js';
import { AgentPool } from '../../src/agents/agent-pool.js';

describe('AgentHealthMonitor', () => {
  let monitor: AgentHealthMonitor | null = null;
  let pool: AgentPool | null = null;

  afterEach(() => {
    if (monitor) monitor.stop();
    if (pool) pool.killAll();
  });

  it('detects crashed agents and calls onCrash', async () => {
    pool = new AgentPool();
    const onCrash = vi.fn();
    const onUnresponsive = vi.fn();
    monitor = new AgentHealthMonitor(pool, {
      intervalMs: 50,
      timeoutMs: 500,
      onCrash,
      onUnresponsive,
    });

    const proc = pool.spawnLongRunning(
      'agent-1',
      'session-1',
      '/tmp/test.db',
      'supervisor',
      'node',
      ['-e', 'process.stdin.resume()'],
    );
    proc.kill();
    await new Promise(r => setTimeout(r, 50));

    monitor.start();
    await new Promise(r => setTimeout(r, 120));

    expect(onCrash).toHaveBeenCalledWith('agent-1', 'supervisor');
    expect(onUnresponsive).not.toHaveBeenCalled();
  });

  it('detects unresponsive agents via healthcheck timeout', async () => {
    pool = new AgentPool();
    const onCrash = vi.fn();
    const onUnresponsive = vi.fn();

    const proc = pool.spawnLongRunning(
      'agent-2',
      'session-2',
      '/tmp/test.db',
      'coder',
      'node',
      ['-e', 'process.stdin.resume()'],
    );
    proc.send = () => {};

    monitor = new AgentHealthMonitor(pool, {
      intervalMs: 50,
      timeoutMs: 80,
      onCrash,
      onUnresponsive,
    });

    monitor.start();
    await new Promise(r => setTimeout(r, 250));

    expect(onUnresponsive).toHaveBeenCalledWith('agent-2', 'coder');
    expect(onCrash).not.toHaveBeenCalled();
  });

  it('handles successful healthcheck responses', async () => {
    pool = new AgentPool();
    const onCrash = vi.fn();
    const onUnresponsive = vi.fn();

    pool.spawnLongRunning(
      'agent-3',
      'session-3',
      '/tmp/test.db',
      'supervisor',
      'node',
      ['-e', 'process.stdin.resume()'],
    );

    monitor = new AgentHealthMonitor(pool, {
      intervalMs: 50,
      timeoutMs: 500,
      onCrash,
      onUnresponsive,
    });

    monitor.start();

    await new Promise(r => setTimeout(r, 80));

    const response = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { status: 'ok' },
    });
    monitor.handleResponse('agent-3', response);

    await new Promise(r => setTimeout(r, 150));

    expect(onCrash).not.toHaveBeenCalled();
    expect(onUnresponsive).not.toHaveBeenCalled();
  });
});
