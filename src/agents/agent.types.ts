import type { AgentType } from '../types/common.js';

export interface AgentProcessConfig {
  command: string;
  args: string[];
  agentType: AgentType;
  sessionId: string;
  memoryDbPath: string;
  /**
   * Extra environment variables to set on the child process.
   * Callers must not override security-sensitive variables
   * (e.g. PATH, LD_PRELOAD, HOME). Implementations should
   * merge these with a fixed allowlist rather than a raw spread.
   */
  env?: Record<string, string>;
}

export interface AgentStatus {
  agentType: AgentType;
  sessionId: string;
  /** null means the process is not currently running */
  pid: number | null;
  running: boolean;
  spawnedAt: string;
  lastHealthcheck: string | null;
}
