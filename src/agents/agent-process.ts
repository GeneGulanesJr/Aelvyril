import { ChildProcess, spawn } from 'child_process';
import type { AgentProcessConfig, AgentStatus } from './agent.types.js';

const ALLOWED_ENV_VARS = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'NODE_PATH',
]);

function buildEnv(config: AgentProcessConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ALLOWED_ENV_VARS) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key]!;
    }
  }
  if (config.env) {
    Object.assign(env, config.env);
  }
  env['AELVYRIL_SESSION_ID'] = config.sessionId;
  env['AELVYRIL_MEMORY_DB'] = config.memoryDbPath;
  env['AELVYRIL_AGENT_TYPE'] = config.agentType;
  return env;
}

export class AgentProcess {
  private child: ChildProcess | null = null;
  private readonly config: AgentProcessConfig;
  private readonly spawnedAt: string;
  private lastHealthcheck: string | null = null;
  private stderrCallbacks: ((data: Buffer) => void)[] = [];
  private stdoutCallbacks: ((data: Buffer) => void)[] = [];
  private _killed = false;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: AgentProcessConfig) {
    this.config = config;
    this.spawnedAt = new Date().toISOString();
    this.spawn();
  }

  private spawn(): void {
    const env = buildEnv(this.config);
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
    this.child.on('error', () => {
      this.child = null;
      this._killed = true;
      if (this.killTimer) {
        clearTimeout(this.killTimer);
        this.killTimer = null;
      }
    });
    this.child.on('exit', () => {
      this.child = null;
      if (this.killTimer) {
        clearTimeout(this.killTimer);
        this.killTimer = null;
      }
    });
  }

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && !this._killed;
  }

  getPid(): number | null {
    return this.child?.pid ?? null;
  }

  send(data: string): void {
    const child = this.child;
    if (!child?.stdin) throw new Error('Agent process not running');
    const ok = child.stdin.write(data);
    if (!ok) {
      child.stdin.once('drain', () => {});
    }
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
    if (!this.child || this._killed) return;
    this._killed = true;
    this.child.kill('SIGTERM');
    this.killTimer = setTimeout(() => {
      if (this.child && !this.child.killed) {
        this.child.kill('SIGKILL');
      }
    }, 5000);
  }
}
