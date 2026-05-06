import { AgentProcess } from './agent-process.js';
import type { AgentType } from '../types/common.js';
import type { AgentStatus } from './agent.types.js';

interface PooledAgent {
  process: AgentProcess;
  type: 'long_running' | 'ephemeral';
  agentType: AgentType;
}

export class AgentPool {
  private agents: Map<string, PooledAgent> = new Map();

  spawnLongRunning(
    id: string, sessionId: string, memoryDbPath: string, agentType: AgentType
  ): AgentProcess {
    return this.spawn(id, sessionId, memoryDbPath, agentType, 'long_running');
  }

  spawnEphemeral(
    id: string, sessionId: string, memoryDbPath: string,
    agentType: AgentType, env?: Record<string, string>
  ): AgentProcess {
    return this.spawn(id, sessionId, memoryDbPath, agentType, 'ephemeral', env);
  }

  private spawn(
    id: string, sessionId: string, memoryDbPath: string,
    agentType: AgentType, type: 'long_running' | 'ephemeral',
    env?: Record<string, string>
  ): AgentProcess {
    const existing = this.agents.get(id);
    if (existing) {
      try { existing.process.kill(); } finally { this.agents.delete(id); }
    }
    const proc = new AgentProcess({
      command: 'pi', args: ['--agent', agentType],
      agentType, sessionId, memoryDbPath, env,
    });
    this.agents.set(id, { process: proc, type, agentType });
    return proc;
  }

  get(id: string): AgentProcess | null {
    return this.agents.get(id)?.process ?? null;
  }

  kill(id: string): void {
    const agent = this.agents.get(id);
    if (agent) {
      try { agent.process.kill(); } finally { this.agents.delete(id); }
    }
  }

  killAll(): void {
    for (const id of [...this.agents.keys()]) { this.kill(id); }
  }

  killEphemeral(): void {
    const ephemeralIds: string[] = [];
    for (const [id, agent] of this.agents) {
      if (agent.type === 'ephemeral') ephemeralIds.push(id);
    }
    for (const id of ephemeralIds) { this.kill(id); }
  }

  getAllStatuses(): Map<string, AgentStatus> {
    const statuses = new Map<string, AgentStatus>();
    for (const [id, agent] of this.agents) {
      statuses.set(id, agent.process.getStatus());
    }
    return statuses;
  }

  getByAgentType(agentType: AgentType): AgentProcess[] {
    const result: AgentProcess[] = [];
    for (const agent of this.agents.values()) {
      if (agent.agentType === agentType) {
        result.push(agent.process);
      }
    }
    return result;
  }

  dispose(): void {
    this.killAll();
  }
}
