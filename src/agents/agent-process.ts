import { ChildProcess, spawn } from 'child_process';
import type { AgentProcessConfig, AgentStatus } from './agent.types.js';

export class AgentProcess {
  private child: ChildProcess | null = null;
  private readonly config: AgentProcessConfig;
  private readonly spawnedAt: string;
  private lastHealthcheck: string | null = null;
  private stderrCallbacks: ((data: Buffer) => void)[] = [];
  private stdoutCallbacks: ((data: Buffer) => void)[] = [];

  constructor(config: AgentProcessConfig) {
    this.config = config;
    this.spawnedAt = new Date().toISOString();
    this.spawn();
  }

  private spawn(): void {
    const env = {
      ...process.env,
      ...this.config.env,
      AELVYRIL_SESSION_ID: this.config.sessionId,
      AELVYRIL_MEMORY_DB: this.config.memoryDbPath,
      AELVYRIL_AGENT_TYPE: this.config.agentType,
    };

    this.child = spawn(this.config.command, this.config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    this.child.stdout?.on('data', (data: Buffer) => {
      for (const cb of this.stdoutCallbacks) cb(data);
    });

    this.child.stderr?.on('data', (data: Buffer) => {
      for (const cb of this.stderrCallbacks) cb(data);
    });

    this.child.on('exit', () => {
      this.child = null;
    });
  }

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  getPid(): number | null {
    return this.child?.pid ?? null;
  }

  send(data: string): void {
    if (!this.child?.stdin) throw new Error('Agent process not running');
    this.child.stdin.write(data);
  }

  onStdout(callback: (data: Buffer) => void): void {
    this.stdoutCallbacks.push(callback);
  }

  onStderr(callback: (data: Buffer) => void): void {
    this.stderrCallbacks.push(callback);
  }

  getStatus(): AgentStatus {
    return {
      agentType: this.config.agentType,
      sessionId: this.config.sessionId,
      pid: this.getPid(),
      running: this.isRunning(),
      spawnedAt: this.spawnedAt,
      lastHealthcheck: this.lastHealthcheck,
    };
  }

  updateHealthcheck(): void {
    this.lastHealthcheck = new Date().toISOString();
  }

  kill(): void {
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }
}
