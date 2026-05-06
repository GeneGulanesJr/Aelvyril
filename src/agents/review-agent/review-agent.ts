import { collectDiff, type DiffResult } from './diff-collector.js';
import { buildReviewPrompt } from './review-prompt.js';
import { parseReviewDecision, type ReviewDecision } from './review-decision-parser.js';
import type { AgentPool } from '../agent-pool.js';
import type { BoardManager } from '../../board/board-manager.js';
import type { Ticket } from '../../types/common.js';
import { mergeTicketBranch, resetTicketBranch } from '../main-agent/git-operations.js';

export interface ReviewAgentConfig {
  sessionId: string;
  sessionBranch: string;
  memoryDbPath: string;
  workspacePath: string;
}

export class ReviewAgent {
  constructor(
    private pool: AgentPool,
    private board: BoardManager,
    private config: ReviewAgentConfig
  ) {}

  async execute(ticket: Ticket, memoryContext: string[]): Promise<ReviewDecision> {
    const diff: DiffResult = collectDiff(
      this.config.workspacePath,
      ticket.git_branch!,
      this.config.sessionBranch
    );

    const prompt = buildReviewPrompt(ticket, diff, memoryContext);

    const agentId = `review-${ticket.id}-${Date.now()}`;
    const proc = this.pool.spawnEphemeral(
      agentId,
      this.config.sessionId,
      this.config.memoryDbPath,
      'review',
      {
        AELVYRIL_TICKET_ID: ticket.id,
        AELVYRIL_TICKET_PROMPT: prompt,
        AELVYRIL_WORKSPACE: this.config.workspacePath,
      }
    );

    let rawResponse = '';
    proc.onStdout((data) => {
      rawResponse += data.toString();
    });

    await new Promise<void>(resolve => {
      const check = setInterval(() => {
        if (!proc.isRunning()) {
          clearInterval(check);
          resolve();
        }
      }, 1000);
      setTimeout(() => {
        clearInterval(check);
        proc.kill();
        resolve();
      }, 300000);
    });

    const decision = parseReviewDecision(rawResponse);

    if (decision.approved) {
      mergeTicketBranch(this.config.workspacePath, ticket.id, this.config.sessionId);
      this.board.transition(ticket.id, 'done');
    } else {
      resetTicketBranch(this.config.workspacePath, ticket.id, this.config.sessionId);
      this.board.reject(ticket.id, decision.notes);
    }

    const tokensEstimate = prompt.length / 4;
    this.board.addCost(ticket.id, tokensEstimate, tokensEstimate * 0.00001);

    return decision;
  }
}
