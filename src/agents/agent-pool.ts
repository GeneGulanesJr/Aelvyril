import { AgentProcess } from './agent-process.js';
import type { AgentType } from '../types/common.js';
import type { AgentStatus } from './agent.types.js';

interface PooledAgent {
  process: AgentProcess;
  type: 'long_running' | 'ephemeral';
}

export class AgentPool {
  private agents: Map<string, PooledAgent> = new Map();

  spawnLongRunning(
    id: string,
    sessionId: string,
    memoryDbPath: string,
    agentType: AgentType,
    command: string = 'pi',
    args: string[] = ['--agent', agentType]
  ): AgentProcess {
    const proc = new AgentProcess({
      command,
      args,
      agentType,
      sessionId,
      memoryDbPath,
    });
    this.agents.set(id, { process: proc, type: 'long_running' });
    return proc;
  }

  spawnEphemeral(
    id: string,
    sessionId: string,
    memoryDbPath: string,
    agentType: AgentType,
    env?: Record<string, string>,
    command: string = 'pi',
    args: string[] = ['--agent', agentType]
  ): AgentProcess {
    const proc = new AgentProcess({
      command,
      args,
      agentType,
      sessionId,
      memoryDbPath,
      env,
    });
    this.agents.set(id, { process: proc, type: 'ephemeral' });
    return proc;
  }

  get(id: string): AgentProcess | null {
    return this.agents.get(id)?.process ?? null;
  }

  kill(id: string): void {
    const agent = this.agents.get(id);
    if (agent) {
      agent.process.kill();
      this.agents.delete(id);
    }
  }

  killAll(): void {
    for (const [id] of this.agents) {
      this.kill(id);
    }
  }

  killEphemeral(): void {
    for (const [id, agent] of this.agents) {
      if (agent.type === 'ephemeral') {
        agent.process.kill();
        this.agents.delete(id);
      }
    }
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
      if (agent.process.getStatus().agentType === agentType) {
        result.push(agent.process);
      }
    }
    return result;
  }
}
