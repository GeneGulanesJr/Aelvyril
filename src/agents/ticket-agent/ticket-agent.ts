import { buildTicketPrompt } from './prompt-builder.js';
import { parsePlanResponse, type ParsedPlan } from './plan-parser.js';
import type { AgentPool } from '../agent-pool.js';

export interface TicketAgentConfig {
  sessionId: string;
  memoryDbPath: string;
  workspacePath: string;
  userRequest: string;
  memoryContext: string[];
}

export async function runTicketAgent(
  pool: AgentPool,
  config: TicketAgentConfig
): Promise<ParsedPlan> {
  const prompt = buildTicketPrompt(config.userRequest, config.memoryContext);

  const agentId = `ticket-${config.sessionId}-${Date.now()}`;
  const proc = pool.spawnEphemeral(agentId, config.sessionId, config.memoryDbPath, 'ticket', {
    AELVYRIL_TICKET_PROMPT: prompt,
    AELVYRIL_WORKSPACE: config.workspacePath,
  });

  let rawOutput = '';
  proc.onStdout((data: Buffer) => {
    rawOutput += data.toString();
  });

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!proc.isRunning()) {
        clearInterval(check);
        resolve();
      }
    }, 500);
    setTimeout(() => {
      clearInterval(check);
      proc.kill();
      resolve();
    }, 120000);
  });

  pool.kill(agentId);

  return parsePlanResponse(rawOutput);
}
