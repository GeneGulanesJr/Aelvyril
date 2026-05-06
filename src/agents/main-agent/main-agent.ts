import { getNextDispatchable } from './wave-executor.js';
import {
  createTicketBranch,
  mergeTicketBranch,
  resetTicketBranch,
  createPR,
  mergePR,
} from './git-operations.js';
import type { AgentPool } from '../agent-pool.js';
import type { BoardManager } from '../../board/board-manager.js';
import type { TestResult } from '../../types/common.js';

export interface MainAgentConfig {
  sessionId: string;
  memoryDbPath: string;
  workspacePath: string;
  autoMerge: boolean;
  maxIterations?: number;
}

export interface MainAgentResult {
  completed: boolean;
  prUrl: string | null;
  ticketsProcessed: number;
  ticketsFailed: number;
}

export async function runMainAgent(
  pool: AgentPool,
  board: BoardManager,
  config: MainAgentConfig
): Promise<MainAgentResult> {
  const plan = board.getConcurrencyPlan();
  if (!plan) {
    throw new Error('No concurrency plan found for session');
  }

  const maxIterations = config.maxIterations ?? 100;
  let ticketsProcessed = 0;
  let ticketsFailed = 0;
  let currentlyRunning = 0;
  const runningAgents = new Map<string, string>();

  for (let i = 0; i < maxIterations; i++) {
    const currentTickets = board.getTickets();
    const dispatchable = getNextDispatchable(currentTickets, plan, currentlyRunning);

    if (dispatchable.length === 0 && currentlyRunning === 0) {
      break;
    }

    for (const ticketId of dispatchable) {
      const ticket = currentTickets.find(t => t.id === ticketId);
      if (!ticket) continue;

      createTicketBranch(config.workspacePath, ticketId, config.sessionId);
      board.transition(ticketId, 'in_progress');

      const agentId = `sub-${ticketId}-${Date.now()}`;
      pool.spawnEphemeral(agentId, config.sessionId, config.memoryDbPath, 'sub', {
        AELVYRIL_TICKET_ID: ticketId,
        AELVYRIL_WORKSPACE: config.workspacePath,
      });
      board.assignAgent(ticketId, agentId);

      runningAgents.set(ticketId, agentId);
      currentlyRunning++;
    }

    const completed: string[] = [];
    for (const [ticketId, agentId] of runningAgents) {
      const proc = pool.get(agentId);
      if (proc && !proc.isRunning()) {
        completed.push(ticketId);
        pool.kill(agentId);
      }
    }

    for (const ticketId of completed) {
      runningAgents.delete(ticketId);
      currentlyRunning--;

      try {
        const testAgentId = `test-${ticketId}-${Date.now()}`;
        pool.spawnEphemeral(testAgentId, config.sessionId, config.memoryDbPath, 'test', {
          AELVYRIL_TICKET_ID: ticketId,
          AELVYRIL_WORKSPACE: config.workspacePath,
        });

        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            const proc = pool.get(testAgentId);
            if (!proc || !proc.isRunning()) {
              clearInterval(check);
              resolve();
            }
          }, 1000);
          setTimeout(() => {
            clearInterval(check);
            pool.kill(testAgentId);
            resolve();
          }, 120000);
        });

        const updatedTicket = board.getTicket(ticketId);
        const testResult = updatedTicket?.test_results;

        if (testResult?.passed) {
          board.transition(ticketId, 'in_review');

          const reviewAgentId = `review-${ticketId}-${Date.now()}`;
          pool.spawnEphemeral(reviewAgentId, config.sessionId, config.memoryDbPath, 'review', {
            AELVYRIL_TICKET_ID: ticketId,
            AELVYRIL_WORKSPACE: config.workspacePath,
          });

          await new Promise<void>((resolve) => {
            const check = setInterval(() => {
              const proc = pool.get(reviewAgentId);
              if (!proc || !proc.isRunning()) {
                clearInterval(check);
                resolve();
              }
            }, 1000);
            setTimeout(() => {
              clearInterval(check);
              pool.kill(reviewAgentId);
              resolve();
            }, 60000);
          });

          mergeTicketBranch(config.workspacePath, ticketId, config.sessionId);
          board.transition(ticketId, 'done');
          ticketsProcessed++;
        } else {
          resetTicketBranch(config.workspacePath, ticketId, config.sessionId);
          board.transition(ticketId, 'in_progress');
          ticketsFailed++;
        }
      } catch {
        resetTicketBranch(config.workspacePath, ticketId, config.sessionId);
        board.hold(ticketId, `Error processing ticket ${ticketId}`);
        ticketsFailed++;
      }
    }

    if (completed.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  let prUrl: string | null = null;
  const allDone = board.getTickets().every(t => t.status === 'done');

  if (allDone) {
    prUrl = createPR(config.workspacePath, config.sessionId);
    if (config.autoMerge) {
      mergePR(config.workspacePath, config.sessionId);
    }
  }

  return {
    completed: allDone,
    prUrl,
    ticketsProcessed,
    ticketsFailed,
  };
}
