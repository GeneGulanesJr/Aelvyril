import { describe, it, expect, afterEach } from 'vitest';
import { AgentProcess } from '../../src/agents/agent-process.js';

describe('AgentProcess', () => {
  let processes: AgentProcess[] = [];

  afterEach(() => {
    for (const p of processes) { p.kill(); }
    processes = [];
  });

  it('spawns a process and detects lifecycle', async () => {
    const proc = new AgentProcess({
      command: 'cat', args: [], agentType: 'supervisor',
      sessionId: 'test-session', memoryDbPath: '/tmp/test-memory.db',
    });
    processes.push(proc);
    expect(proc.isRunning()).toBe(true);
    proc.kill();
    const start = Date.now();
    while (proc.isRunning() && Date.now() - start < 5000) {
      await new Promise(r => setTimeout(r, 10));
    }
    expect(proc.isRunning()).toBe(false);
  });

  it('captures stderr output', async () => {
    const proc = new AgentProcess({
      command: 'node', args: ['-e', 'console.error("test error")'],
      agentType: 'test', sessionId: 'test-session', memoryDbPath: '/tmp/test-memory.db',
    });
    processes.push(proc);

    const timeout = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error('stderr capture timed out')), 5000)
    );
    const error = new Promise<string>(resolve => {
      proc.onStderr((data) => resolve(data.toString()));
    });

    const result = await Promise.race([error, timeout]);
    expect(result).toContain('test error');
  });
});
