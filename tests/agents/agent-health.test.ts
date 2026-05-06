import { describe, it, expect, vi } from 'vitest';
import { AgentHealthMonitor } from '../../src/agents/agent-health.js';
import { AgentPool } from '../../src/agents/agent-pool.js';

describe('AgentHealthMonitor', () => {
  it('detects crashed agents and calls callback', () => {
    const pool = new AgentPool();
    const onCrash = vi.fn();
    const monitor = new AgentHealthMonitor(pool, {
      intervalMs: 100,
      timeoutMs: 50,
      onCrash,
      onUnresponsive: vi.fn(),
    });

    monitor.start();
    expect(onCrash).not.toHaveBeenCalled();
    monitor.stop();
  });
});
