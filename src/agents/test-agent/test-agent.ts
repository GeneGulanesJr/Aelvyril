import { runTests, type TestRunResult } from './test-runner.js';
import { parseVitestOutput } from './test-result-parser.js';
import { buildTestPrompt } from './test-prompt.js';
import type { AgentPool } from '../agent-pool.js';
import type { BoardManager } from '../../board/board-manager.js';
import type { Ticket, TestResult } from '../../types/common.js';
import { execSync } from 'child_process';

export interface TestAgentConfig {
  sessionId: string;
  memoryDbPath: string;
  workspacePath: string;
  testTimeoutMs?: number;
}

export class TestAgent {
  constructor(
    private pool: AgentPool,
    private board: BoardManager,
    private config: TestAgentConfig
  ) {}

  async execute(ticket: Ticket, memoryContext: string[]): Promise<TestResult> {
    const agentId = `test-${ticket.id}-${Date.now()}`;

    try {
      execSync(`git checkout "${ticket.git_branch}"`, {
        cwd: this.config.workspacePath,
        stdio: 'pipe',
      });
    } catch {
      return this.errorResult(ticket.git_branch!, 'Failed to checkout ticket branch');
    }

    const prompt = buildTestPrompt(ticket, memoryContext);
    try {
      const proc = this.pool.spawnEphemeral(agentId, this.config.sessionId, this.config.memoryDbPath, 'test', {
        AELVYRIL_TICKET_ID: ticket.id,
        AELVYRIL_TICKET_PROMPT: prompt,
        AELVYRIL_WORKSPACE: this.config.workspacePath,
      });

      await new Promise<void>(resolve => {
        const check = setInterval(() => {
          if (!proc.isRunning()) {
            clearInterval(check);
            resolve(undefined);
          }
        }, 1000);
        setTimeout(() => {
          clearInterval(check);
          proc.kill();
          resolve(undefined);
        }, 300000);
      });
    } catch {
      // Continue to run tests even if agent had issues
    }

    let runResult: TestRunResult;
    try {
      runResult = await runTests(this.config.workspacePath, {
        timeoutMs: this.config.testTimeoutMs ?? 120000,
      });
    } catch {
      return this.errorResult(ticket.git_branch!, 'Test runner failed to execute');
    }

    const result = parseVitestOutput(runResult.output, ticket.git_branch!);

    this.board.setTestResults(ticket.id, result);

    const tokensEstimate = prompt.length / 4;
    this.board.addCost(ticket.id, tokensEstimate, tokensEstimate * 0.00001);

    return result;
  }

  private errorResult(branch: string, message: string): TestResult {
    return {
      passed: false,
      total: 0,
      passed_count: 0,
      failed_count: 0,
      failures: [{ test_name: '(setup)', message }],
      coverage_delta: null,
      duration_ms: 0,
      test_branch: branch,
      timestamp: new Date().toISOString(),
    };
  }
}
