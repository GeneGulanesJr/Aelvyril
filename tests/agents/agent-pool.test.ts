import { describe, it, expect, afterEach, vi } from 'vitest';
import { AgentPool } from '../../src/agents/agent-pool.js';

vi.mock('../../src/agents/agent-process.js', () => {
  const processes: { kill: ReturnType<typeof vi.fn>; getStatus: ReturnType<typeof vi.fn>; isRunning: () => boolean }[] = [];

  class MockAgentProcess {
    public killed = false;
    private config: { agentType: string; sessionId: string };
    constructor(config: { agentType: string; sessionId: string; memoryDbPath: string; command: string; args: string[]; env?: Record<string, string> }) {
      this.config = config;
    }
    kill() { this.killed = true; }
    getStatus() {
      return {
        agentType: this.config.agentType,
        sessionId: this.config.sessionId,
        pid: this.killed ? null : 12345,
        spawnedAt: '2026-01-01T00:00:00.000Z',
        lastHealthcheck: null,
      };
    }
    isRunning() { return !this.killed; }
  }

  return {
    AgentProcess: MockAgentProcess,
  };
});

describe('AgentPool', () => {
  let pool: AgentPool;

  afterEach(() => {
    pool?.dispose();
  });

  it('spawns a long-running agent and retrieves it', () => {
    pool = new AgentPool();
    const proc = pool.spawnLongRunning('agent-1', 'sess-1', '/tmp/test.db', 'test');
    expect(proc).toBeDefined();
    expect(pool.get('agent-1')).toBe(proc);
  });

  it('spawns an ephemeral agent and retrieves it', () => {
    pool = new AgentPool();
    const proc = pool.spawnEphemeral('eph-1', 'sess-1', '/tmp/test.db', 'test');
    expect(proc).toBeDefined();
    expect(pool.get('eph-1')).toBe(proc);
  });

  it('returns null for unknown agent id', () => {
    pool = new AgentPool();
    expect(pool.get('nonexistent')).toBeNull();
  });

  it('kills a specific agent and removes it from pool', () => {
    pool = new AgentPool();
    const proc = pool.spawnLongRunning('agent-1', 'sess-1', '/tmp/test.db', 'test') as { kill: () => void };
    pool.kill('agent-1');
    expect(pool.get('agent-1')).toBeNull();
  });

  it('kill() is a no-op for unknown id', () => {
    pool = new AgentPool();
    expect(() => pool.kill('nonexistent')).not.toThrow();
  });

  it('killAll() removes all agents', () => {
    pool = new AgentPool();
    pool.spawnLongRunning('a1', 'sess-1', '/tmp/test.db', 'test');
    pool.spawnLongRunning('a2', 'sess-1', '/tmp/test.db', 'review');
    pool.spawnEphemeral('e1', 'sess-1', '/tmp/test.db', 'test');
    pool.killAll();
    expect(pool.get('a1')).toBeNull();
    expect(pool.get('a2')).toBeNull();
    expect(pool.get('e1')).toBeNull();
  });

  it('killEphemeral() only removes ephemeral agents', () => {
    pool = new AgentPool();
    pool.spawnLongRunning('lr-1', 'sess-1', '/tmp/test.db', 'test');
    pool.spawnEphemeral('eph-1', 'sess-1', '/tmp/test.db', 'test');
    pool.killEphemeral();
    expect(pool.get('lr-1')).not.toBeNull();
    expect(pool.get('eph-1')).toBeNull();
  });

  it('duplicate id kills previous process', () => {
    pool = new AgentPool();
    const first = pool.spawnLongRunning('dup-1', 'sess-1', '/tmp/test.db', 'test') as { killed: boolean };
    pool.spawnLongRunning('dup-1', 'sess-1', '/tmp/test.db', 'review');
    expect(pool.get('dup-1')).not.toBe(first);
    expect(first.killed).toBe(true);
  });

  it('getAllStatuses() returns status for each agent', () => {
    pool = new AgentPool();
    pool.spawnLongRunning('a1', 'sess-1', '/tmp/test.db', 'test');
    pool.spawnLongRunning('a2', 'sess-2', '/tmp/test.db', 'review');
    const statuses = pool.getAllStatuses();
    expect(statuses.size).toBe(2);
    expect(statuses.get('a1')?.sessionId).toBe('sess-1');
    expect(statuses.get('a2')?.sessionId).toBe('sess-2');
  });

  it('getAllStatuses() returns empty map for empty pool', () => {
    pool = new AgentPool();
    const statuses = pool.getAllStatuses();
    expect(statuses.size).toBe(0);
  });

  it('getByAgentType() filters agents by type', () => {
    pool = new AgentPool();
    pool.spawnLongRunning('a1', 'sess-1', '/tmp/test.db', 'test');
    pool.spawnLongRunning('a2', 'sess-1', '/tmp/test.db', 'review');
    pool.spawnLongRunning('a3', 'sess-1', '/tmp/test.db', 'test');
    const testAgents = pool.getByAgentType('test');
    expect(testAgents.length).toBe(2);
    const reviewAgents = pool.getByAgentType('review');
    expect(reviewAgents.length).toBe(1);
    const none = pool.getByAgentType('supervisor');
    expect(none.length).toBe(0);
  });

  it('dispose() cleans up all agents', () => {
    pool = new AgentPool();
    pool.spawnLongRunning('a1', 'sess-1', '/tmp/test.db', 'test');
    pool.spawnEphemeral('e1', 'sess-1', '/tmp/test.db', 'test');
    pool.dispose();
    expect(pool.get('a1')).toBeNull();
    expect(pool.get('e1')).toBeNull();
  });
});
