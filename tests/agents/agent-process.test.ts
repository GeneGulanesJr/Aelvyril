import { describe, it, expect, afterEach } from 'vitest';
import { AgentProcess } from '../../src/agents/agent-process.js';

describe('AgentProcess', () => {
  let processes: AgentProcess[] = [];

  afterEach(() => {
    for (const p of processes) {
      if (p.isRunning()) p.kill();
    }
    processes = [];
  });

  it('spawns a process and detects when it is ready', async () => {
    const proc = new AgentProcess({
      command: 'cat',
      args: [],
      agentType: 'supervisor',
      sessionId: 'test-session',
      memoryDbPath: '/tmp/test-memory.db',
    });
    processes.push(proc);

    expect(proc.isRunning()).toBe(true);
    proc.kill();
    await new Promise(r => setTimeout(r, 100));
    expect(proc.isRunning()).toBe(false);
  });

  it('spawns with a custom command', async () => {
    const proc = new AgentProcess({
      command: 'node',
      args: ['-e', 'process.stdin.resume()'],
      agentType: 'supervisor',
      sessionId: 'test-session',
      memoryDbPath: '/tmp/test-memory.db',
    });
    processes.push(proc);

    expect(proc.isRunning()).toBe(true);
    proc.kill();
    await new Promise(r => setTimeout(r, 100));
    expect(proc.isRunning()).toBe(false);
  });

  it('captures stderr output', async () => {
    const proc = new AgentProcess({
      command: 'node',
      args: ['-e', 'console.error("test error")'],
      agentType: 'test',
      sessionId: 'test-session',
      memoryDbPath: '/tmp/test-memory.db',
    });
    processes.push(proc);

    const error = await new Promise<string>(resolve => {
      proc.onStderr((data) => resolve(data.toString()));
    });
    expect(error).toContain('test error');
  });
});
