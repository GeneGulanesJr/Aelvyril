import { ChildProcess, spawn } from 'child_process';
import type { AgentProcessConfig, AgentStatus } from './agent.types.js';

const ALLOWED_PARENT_ENV_VARS = new Set([
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TZ',
]);

const BLOCKED_ENV_VARS = new Set([
  'PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'HOME', 'USER', 'SHELL',
  'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH', 'IFS', 'ENV', 'BASH_ENV', 'PYTHONPATH',
  'PERL5LIB', 'RUBYLIB', 'CLASSPATH', 'DOTNET_ROOT', 'JAVA_HOME',
]);

export class AgentProcess {
  private child: ChildProcess | null = null;
  private readonly config: AgentProcessConfig;
  private readonly spawnedAt: string;
  private lastHealthcheck: string | null = null;
  private stderrCallbacks: ((data: Buffer) => void)[] = [];
  private stdoutCallbacks: ((data: Buffer) => void)[] = [];
  private stderrBuffer: Buffer[] = [];
  private stdoutBuffer: Buffer[] = [];

  constructor(config: AgentProcessConfig) {
    this.config = config;
    this.spawnedAt = new Date().toISOString();
    this.spawn();
  }

  private spawn(): void {
    const env: Record<string, string | undefined> = {};
    for (const key of ALLOWED_PARENT_ENV_VARS) {
      if (process.env[key] !== undefined) {
        env[key] = process.env[key];
      }
    }
    if (this.config.env) {
      for (const [key, value] of Object.entries(this.config.env)) {
        if (!BLOCKED_ENV_VARS.has(key)) {
          env[key] = value;
        }
      }
    }
    env.AELVYRIL_SESSION_ID = this.config.sessionId;
    env.AELVYRIL_MEMORY_DB = this.config.memoryDbPath;
    env.AELVYRIL_AGENT_TYPE = this.config.agentType;
    this.child = spawn(this.config.command, this.config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    this.child.stdout?.on('data', (data: Buffer) => {
      this.stdoutBuffer.push(data);
      for (const cb of this.stdoutCallbacks) cb(data);
    });
    this.child.stderr?.on('data', (data: Buffer) => {
      this.stderrBuffer.push(data);
      for (const cb of this.stderrCallbacks) cb(data);
    });
    this.child.on('error', () => { this.child = null; });
    this.child.on('close', () => { this.child = null; });
    this.child.stdin?.on('error', () => {});
  }

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  getPid(): number | null {
    return this.child?.pid ?? null;
  }

  send(data: string): void {
    if (!this.child?.stdin || !this.child.stdin.writable) {
      throw new Error('Agent process not running');
    }
    const line = data.endsWith('\n') ? data : data + '\n';
    this.child.stdin.write(line);
  }

  onStdout(callback: (data: Buffer) => void): void {
    for (const data of this.stdoutBuffer) callback(data);
    this.stdoutCallbacks.push(callback);
  }

  offStdout(callback: (data: Buffer) => void): void {
    this.stdoutCallbacks = this.stdoutCallbacks.filter(cb => cb !== callback);
  }

  onStderr(callback: (data: Buffer) => void): void {
    for (const data of this.stderrBuffer) callback(data);
    this.stderrCallbacks.push(callback);
  }

  offStderr(callback: (data: Buffer) => void): void {
    this.stderrCallbacks = this.stderrCallbacks.filter(cb => cb !== callback);
  }

  getStatus(): AgentStatus {
    return {
      agentType: this.config.agentType,
      sessionId: this.config.sessionId,
      pid: this.getPid(),
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
      setTimeout(() => {
        if (this.child) {
          this.child.kill('SIGKILL');
        }
      }, 5000);
    }
  }
}
