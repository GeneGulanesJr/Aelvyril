import type { AgentType } from '../types/common.js';

export interface AgentProcessConfig {
  command: string;
  args: string[];
  agentType: AgentType;
  sessionId: string;
  memoryDbPath: string;
  env?: Record<string, string>;
}

export interface AgentStatus {
  agentType: AgentType;
  sessionId: string;
  pid: number | null;
  running: boolean;
  spawnedAt: string;
  lastHealthcheck: string | null;
}
