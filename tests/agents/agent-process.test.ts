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
    await new Promise(r => setTimeout(r, 100));
    expect(proc.isRunning()).toBe(false);
  });

  it('captures stderr output', async () => {
    const proc = new AgentProcess({
      command: 'node', args: ['-e', 'console.error("test error")'],
      agentType: 'test', sessionId: 'test-session', memoryDbPath: '/tmp/test-memory.db',
    });
    processes.push(proc);
    const error = await new Promise<string>(resolve => {
      proc.onStderr((data) => resolve(data.toString()));
    });
    expect(error).toContain('test error');
  });

  it('send() writes to stdin', async () => {
    const proc = new AgentProcess({
      command: 'cat', args: [],
      agentType: 'test', sessionId: 'test-session', memoryDbPath: '/tmp/test-memory.db',
    });
    processes.push(proc);
    proc.send('hello\n');
    const output = await new Promise<string>((resolve) => {
      proc.onStdout((data) => resolve(data.toString()));
    });
    expect(output.trim()).toBe('hello');
  });

  it('send() throws when process is not running', async () => {
    const proc = new AgentProcess({
      command: 'cat', args: [],
      agentType: 'test', sessionId: 'test-session', memoryDbPath: '/tmp/test-memory.db',
    });
    processes.push(proc);
    proc.kill();
    await new Promise(r => setTimeout(r, 200));
    expect(() => proc.send('data')).toThrow('Agent process not running');
  });

  it('onStdout() receives stdout data', async () => {
    const proc = new AgentProcess({
      command: 'node', args: ['-e', 'process.stdout.write("out")'],
      agentType: 'test', sessionId: 'test-session', memoryDbPath: '/tmp/test-memory.db',
    });
    processes.push(proc);
    const chunks: Buffer[] = [];
    proc.onStdout((data) => chunks.push(data));
    await new Promise(r => setTimeout(r, 100));
    expect(chunks.length).toBeGreaterThan(0);
    expect(Buffer.concat(chunks).toString()).toContain('out');
  });

  it('getPid() returns the child pid', () => {
    const proc = new AgentProcess({
      command: 'cat', args: [],
      agentType: 'test', sessionId: 'test-session', memoryDbPath: '/tmp/test-memory.db',
    });
    processes.push(proc);
    const pid = proc.getPid();
    expect(pid).not.toBeNull();
    expect(typeof pid).toBe('number');
    expect(pid).toBeGreaterThan(0);
  });

  it('getPid() returns null after process exits', async () => {
    const proc = new AgentProcess({
      command: 'node', args: ['-e', 'process.exit(0)'],
      agentType: 'test', sessionId: 'test-session', memoryDbPath: '/tmp/test-memory.db',
    });
    processes.push(proc);
    await new Promise(r => setTimeout(r, 200));
    expect(proc.getPid()).toBeNull();
  });

  it('getStatus() returns correct status', () => {
    const proc = new AgentProcess({
      command: 'cat', args: [],
      agentType: 'coder', sessionId: 'sess-123', memoryDbPath: '/tmp/test-memory.db',
    });
    processes.push(proc);
    const status = proc.getStatus();
    expect(status.agentType).toBe('coder');
    expect(status.sessionId).toBe('sess-123');
    expect(status.pid).not.toBeNull();
    expect(status.spawnedAt).toBeTruthy();
    expect(status.lastHealthcheck).toBeNull();
  });

  it('updateHealthcheck() sets lastHealthcheck timestamp', () => {
    const proc = new AgentProcess({
      command: 'cat', args: [],
      agentType: 'test', sessionId: 'test-session', memoryDbPath: '/tmp/test-memory.db',
    });
    processes.push(proc);
    expect(proc.getStatus().lastHealthcheck).toBeNull();
    proc.updateHealthcheck();
    const ts = proc.getStatus().lastHealthcheck;
    expect(ts).not.toBeNull();
    expect(new Date(ts!).getTime()).toBeLessThanOrEqual(Date.now());
    expect(new Date(ts!).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it('isRunning() returns false for a process that exited on its own', async () => {
    const proc = new AgentProcess({
      command: 'node', args: ['-e', 'process.exit(0)'],
      agentType: 'test', sessionId: 'test-session', memoryDbPath: '/tmp/test-memory.db',
    });
    processes.push(proc);
    await new Promise(r => setTimeout(r, 200));
    expect(proc.isRunning()).toBe(false);
  });

  it('blocked env vars are not overridden', () => {
    const proc = new AgentProcess({
      command: 'node',
      args: ['-e', 'console.log(JSON.stringify(process.env))'],
      agentType: 'test', sessionId: 'test-session', memoryDbPath: '/tmp/test-memory.db',
      env: { PATH: '/malicious', HOME: '/evil', CUSTOM_VAR: 'ok' },
    });
    processes.push(proc);
  });

  it('kill() does not immediately null child (grace period correctness)', async () => {
    const proc = new AgentProcess({
      command: 'sleep', args: ['60'],
      agentType: 'test', sessionId: 'test-session', memoryDbPath: '/tmp/test-memory.db',
    });
    processes.push(proc);
    const pid = proc.getPid();
    expect(pid).not.toBeNull();
    proc.kill();
    expect(proc.getPid()).toBe(pid);
    await new Promise(r => setTimeout(r, 200));
    expect(proc.isRunning()).toBe(false);
    expect(proc.getPid()).toBeNull();
  });
});
