// src/agents/sub-agent/sub-agent-spawner.ts
import type { AgentPool } from '../agent-pool.js';
import type { Ticket } from '../../types/common.js';
import { buildSubAgentPrompt } from './sub-agent-prompt.js';

export class SubAgentSpawner {
  constructor(private pool: AgentPool) {}

  spawn(
    ticket: Ticket,
    sessionId: string,
    memoryDbPath: string,
    memoryContext: string[]
  ): string {
    const agentId = `sub-${ticket.id}-${Date.now()}`;
    const prompt = buildSubAgentPrompt(ticket, memoryContext);

    this.pool.spawnEphemeral(agentId, sessionId, memoryDbPath, 'sub', {
      AELVYRIL_TICKET_ID: ticket.id,
      AELVYRIL_TICKET_PROMPT: prompt,
      AELVYRIL_WORKSPACE: '',
    });

    return agentId;
  }
}
