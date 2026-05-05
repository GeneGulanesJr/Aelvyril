# Phase 8: Test Agent — Write Test Cases and Run Full Suite

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Test Agent — an ephemeral agent that writes test cases for a ticket's acceptance criteria AND runs the full test suite. Reports pass/fail with structured results. Pass → ticket moves to In Review. Fail → ticket moves back to In Progress with failure context.

**Architecture:** The Test Agent is spawned after a sub-agent completes work. It receives the ticket ID, checks out the ticket branch, writes test cases covering the acceptance criteria, runs the full test suite, and reports structured results. It uses LLM to generate meaningful tests and reads test patterns from PiMemory. Auto-commits test files with `test({id}): add test cases for {title}`.

**Tech Stack:** pi, PiMemoryExtension, child_process (test runner), vitest

**Spec reference:** `docs/superpowers/specs/2026-05-05-cloud-platform-design.md` §3.2, §3.5 (pipeline flow), §3.7 (git strategy)

**Depends on:** Phase 1-7

---

## File Structure

```
src/
├── agents/
│   ├── test-agent/
│   │   ├── test-result-parser.ts # Parse vitest output into TestResult
│   │   ├── test-runner.ts        # Execute test suite in workspace
│   │   ├── test-prompt.ts        # Build prompt for test case writing
│   │   └── test-agent.ts         # Spawn, orchestrate, collect results
tests/
├── agents/
│   └── test-agent/
│       ├── test-result-parser.test.ts
│       ├── test-runner.test.ts
│       └── test-prompt.test.ts
```

---

### Task 1: Test result parser — parse vitest output into TestResult

**Files:**
- Create: `src/agents/test-agent/test-result-parser.ts`
- Test: `tests/agents/test-agent/test-result-parser.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agents/test-agent/test-result-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseVitestOutput } from '../../src/agents/test-agent/test-result-parser.js';

describe('parseVitestOutput', () => {
  it('parses fully passing test output', () => {
    const output = `
 ✓ src/Toggle.test.tsx (2 tests) 45ms
 ✓ src/theme.test.tsx (3 tests) 23ms

 Test Files  2 passed (2)
      Tests  5 passed (5)
   Start at  14:23:01
   Duration  3.12s
`;
    const result = parseVitestOutput(output, 'aelvyril/ticket-#1');
    expect(result.passed).toBe(true);
    expect(result.total).toBe(5);
    expect(result.passed_count).toBe(5);
    expect(result.failed_count).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.test_branch).toBe('aelvyril/ticket-#1');
    expect(result.duration_ms).toBe(3120);
    expect(result.timestamp).toBeDefined();
  });

  it('parses failing test output with failure details', () => {
    const output = `
 ✓ src/theme.test.tsx (3 tests) 23ms
 ✗ src/Toggle.test.tsx (2 tests) 45ms
   × should toggle theme on click
     → expected "dark" received "light"
   ✓ should render toggle button

 Test Files  1 passed, 1 failed (2)
      Tests  4 passed, 1 failed (5)
   Duration  1.50s
`;
    const result = parseVitestOutput(output, 'aelvyril/ticket-#2');
    expect(result.passed).toBe(false);
    expect(result.total).toBe(5);
    expect(result.passed_count).toBe(4);
    expect(result.failed_count).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].test_name).toBe('should toggle theme on click');
    expect(result.failures[0].message).toContain('expected "dark" received "light"');
  });

  it('parses multiple failures', () => {
    const output = `
 ✗ src/api.test.ts (3 tests) 100ms
   × should return 200
     → expected 404 received 200
   × should return JSON
     → expected "text/html" received "application/json"
   ✓ should have body

 Test Files  0 passed, 1 failed (1)
      Tests  1 passed, 2 failed (3)
`;
    const result = parseVitestOutput(output, 'aelvyril/ticket-#3');
    expect(result.passed).toBe(false);
    expect(result.failed_count).toBe(2);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0].test_name).toBe('should return 200');
    expect(result.failures[1].test_name).toBe('should return JSON');
  });

  it('handles empty/timeout output', () => {
    const result = parseVitestOutput('', 'aelvyril/ticket-#4');
    expect(result.passed).toBe(false);
    expect(result.total).toBe(0);
    expect(result.failed_count).toBe(0);
    expect(result.failures[0]?.message).toContain('timeout');
  });

  it('extracts duration', () => {
    const output = `
 ✓ src/test.ts (1 test) 10ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Duration  2.45s
`;
    const result = parseVitestOutput(output, 'aelvyril/ticket-#5');
    expect(result.duration_ms).toBe(2450);
  });

  it('defaults duration to 0 when not found', () => {
    const output = `
 ✓ src/test.ts (1 test) 10ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
`;
    const result = parseVitestOutput(output, 'aelvyril/ticket-#6');
    expect(result.duration_ms).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agents/test-agent/test-result-parser.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write test-result-parser.ts**

```typescript
// src/agents/test-agent/test-result-parser.ts
import type { TestResult } from '../../types/common.js';

export function parseVitestOutput(output: string, testBranch: string): TestResult {
  // Handle empty output (timeout or no output)
  if (!output || output.trim().length === 0) {
    return {
      passed: false,
      total: 0,
      passed_count: 0,
      failed_count: 0,
      failures: [{ test_name: '(unknown)', message: 'Test run produced no output — likely timed out' }],
      coverage_delta: null,
      duration_ms: 0,
      test_branch: testBranch,
      timestamp: new Date().toISOString(),
    };
  }

  // Extract total counts from "Tests  N passed, M failed (T)" or "Tests  N passed (T)"
  const testsLine = output.match(/Tests\s+(\d+)\s+passed(?:,\s+(\d+)\s+failed)?\s+\((\d+)\)/);
  const passedCount = testsLine ? parseInt(testsLine[1], 10) : 0;
  const failedCount = testsLine && testsLine[2] ? parseInt(testsLine[2], 10) : 0;
  const total = testsLine ? parseInt(testsLine[3], 10) : 0;

  // Extract individual failures — lines starting with ×
  const failures: { test_name: string; message: string }[] = [];
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const failMatch = lines[i].match(/^\s*×\s+(.+)/);
    if (failMatch) {
      const testName = failMatch[1].trim();
      // Look ahead for the → message on the next line
      let message = '';
      if (i + 1 < lines.length) {
        const msgMatch = lines[i + 1].match(/^\s*→\s+(.+)/);
        if (msgMatch) {
          message = msgMatch[1].trim();
        }
      }
      failures.push({ test_name: testName, message });
    }
  }

  // Extract duration
  const durationMatch = output.match(/Duration\s+([\d.]+)s/);
  const durationMs = durationMatch ? Math.round(parseFloat(durationMatch[1]) * 1000) : 0;

  return {
    passed: failedCount === 0 && total > 0,
    total,
    passed_count: passedCount,
    failed_count: failedCount,
    failures,
    coverage_delta: null, // Populated separately if coverage is enabled
    duration_ms: durationMs,
    test_branch: testBranch,
    timestamp: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agents/test-agent/test-result-parser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/test-agent/test-result-parser.ts tests/agents/test-agent/test-result-parser.test.ts
git commit -m "feat: test result parser — parse vitest stdout into structured TestResult"
```

---

### Task 2: Test runner — execute test suite in workspace

**Files:**
- Create: `src/agents/test-agent/test-runner.ts`
- Test: `tests/agents/test-agent/test-runner.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agents/test-agent/test-runner.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runTests } from '../../src/agents/test-agent/test-runner.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

describe('runTests', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-test-runner-'));
    // Create a minimal package.json
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: 'test-runner-fixture',
      type: 'module',
      scripts: { test: 'vitest run' },
    }));
    // Create a passing test
    fs.mkdirSync(path.join(tmpDir, 'tests'));
    fs.writeFileSync(path.join(tmpDir, 'tests', 'example.test.ts'), `
      import { describe, it, expect } from 'vitest';
      describe('fixture', () => {
        it('passes', () => { expect(1 + 1).toBe(2); });
      });
    `);
    // Install vitest
    execSync('npm install vitest --save-dev', { cwd: tmpDir, stdio: 'pipe' });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs tests and returns raw output', async () => {
    const result = await runTests(tmpDir, { timeoutMs: 30000 });
    expect(result.output).toContain('passed');
    expect(result.exitCode).toBe(0);
  });

  it('respects timeout', async () => {
    // Use very short timeout — test will still finish but we check timeout is accepted
    const result = await runTests(tmpDir, { timeoutMs: 5000 });
    expect(result.output).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agents/test-agent/test-runner.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write test-runner.ts**

```typescript
// src/agents/test-agent/test-runner.ts
import { execFileSync } from 'child_process';

export interface TestRunConfig {
  timeoutMs: number;  // Default: 120000
  command?: string;   // Default: 'npx'
  args?: string[];    // Default: ['vitest', 'run']
}

export interface TestRunResult {
  output: string;
  exitCode: number;
  timedOut: boolean;
}

export async function runTests(
  workspace: string,
  config?: Partial<TestRunConfig>
): Promise<TestRunResult> {
  const timeoutMs = config?.timeoutMs ?? 120000;
  const command = config?.command ?? 'npx';
  const args = config?.args ?? ['vitest', 'run'];

  try {
    const output = execFileSync(command, args, {
      cwd: workspace,
      timeout: timeoutMs,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CI: 'true' }, // CI=true disables watch mode
    });

    return {
      output: output.toString(),
      exitCode: 0,
      timedOut: false,
    };
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; killed?: boolean; status?: number };

    if (error.killed) {
      return {
        output: '',
        exitCode: -1,
        timedOut: true,
      };
    }

    // Test failures produce non-zero exit code but still have valid output
    const output = [
      error.stdout?.toString() ?? '',
      error.stderr?.toString() ?? '',
    ].join('\n');

    return {
      output,
      exitCode: error.status ?? 1,
      timedOut: false,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agents/test-agent/test-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/test-agent/test-runner.ts tests/agents/test-agent/test-runner.test.ts
git commit -m "feat: test runner — execute vitest in workspace with timeout and output capture"
```

---

### Task 3: Test prompt builder — prompt for test case writing

**Files:**
- Create: `src/agents/test-agent/test-prompt.ts`
- Test: `tests/agents/test-agent/test-prompt.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agents/test-agent/test-prompt.test.ts
import { describe, it, expect } from 'vitest';
import { buildTestPrompt } from '../../src/agents/test-agent/test-prompt.js';
import type { Ticket } from '../../src/types/common.js';

const baseTicket: Ticket = {
  id: '#1', session_id: 'test', title: 'Add dark mode toggle',
  description: 'Add a toggle that switches between light and dark themes',
  acceptance_criteria: ['Toggle renders', 'Clicking toggles theme', 'Theme persists in localStorage'],
  dependencies: [], files: ['src/Toggle.tsx', 'src/theme.tsx'], priority: 1,
  status: 'testing', assigned_agent: 'sub-1', test_results: null,
  review_notes: null, reject_count: 0, held_reason: null,
  git_branch: 'aelvyril/ticket-#1', cost_tokens: 0, cost_usd: 0,
  created_at: '', updated_at: '',
};

describe('buildTestPrompt', () => {
  it('includes ticket title and description', () => {
    const prompt = buildTestPrompt(baseTicket, []);
    expect(prompt).toContain('Add dark mode toggle');
    expect(prompt).toContain('Add a toggle that switches between light and dark themes');
  });

  it('includes all acceptance criteria', () => {
    const prompt = buildTestPrompt(baseTicket, []);
    expect(prompt).toContain('Toggle renders');
    expect(prompt).toContain('Clicking toggles theme');
    expect(prompt).toContain('Theme persists in localStorage');
  });

  it('includes files to test', () => {
    const prompt = buildTestPrompt(baseTicket, []);
    expect(prompt).toContain('src/Toggle.tsx');
    expect(prompt).toContain('src/theme.tsx');
  });

  it('includes git branch', () => {
    const prompt = buildTestPrompt(baseTicket, []);
    expect(prompt).toContain('aelvyril/ticket-#1');
  });

  it('includes memory context with test patterns', () => {
    const prompt = buildTestPrompt(baseTicket, [
      'Memory: Test pattern — use renderHook for custom hooks',
      'Memory: Tests use @testing-library/react',
    ]);
    expect(prompt).toContain('renderHook for custom hooks');
    expect(prompt).toContain('@testing-library/react');
  });

  it('instructs co-located test file placement', () => {
    const prompt = buildTestPrompt(baseTicket, []);
    expect(prompt).toContain('__tests__');
  });

  it('instructs agent to NOT run tests', () => {
    const prompt = buildTestPrompt(baseTicket, []);
    expect(prompt).toContain('DO NOT run');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agents/test-agent/test-prompt.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write test-prompt.ts**

```typescript
// src/agents/test-agent/test-prompt.ts
import type { Ticket } from '../../types/common.js';

export function buildTestPrompt(ticket: Ticket, memoryContext: string[]): string {
  const contextBlock = memoryContext.length > 0
    ? `\n## Test Patterns & Conventions (from memory)\n${memoryContext.map(m => `- ${m}`).join('\n')}\n`
    : '';

  return `You are a Test Agent for Aelvyril. Your job is to write test cases for a completed ticket.

## Ticket #${ticket.id}: ${ticket.title}
${ticket.description}

## Files Under Test
${ticket.files.map(f => `- ${f}`).join('\n')}

## Acceptance Criteria (each must have at least one test)
${ticket.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}
${contextBlock}
## Git Branch
You are working on branch: \`${ticket.git_branch}\`

## Rules
1. Write tests for EVERY acceptance criterion listed above
2. Place test files in co-located \`__tests__\` directories (e.g., \`src/Toggle.tsx\` → \`src/__tests__/Toggle.test.tsx\`)
3. Use the project's existing test framework (vitest, jest, etc.)
4. Test both happy paths and edge cases
5. Mock external dependencies appropriately
6. DO NOT run the tests — that is handled separately
7. After writing all test files, stage and commit with: \`git commit -m "test(${ticket.id}): add test cases for ${ticket.title}"\`
8. Save any discovered test patterns or conventions to memory

## Output
After committing, output a single JSON object:
\`\`\`json
{
  "test_files_written": ["path/to/test1.test.ts", "path/to/test2.test.ts"],
  "tests_per_criterion": {
    "Toggle renders": 2,
    "Clicking toggles theme": 1
  },
  "summary": "Brief description of test coverage"
}
\`\`\``;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agents/test-agent/test-prompt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/test-agent/test-prompt.ts tests/agents/test-agent/test-prompt.test.ts
git commit -m "feat: test prompt builder — ticket-specific prompt for test case writing"
```

---

### Task 4: Test agent orchestrator — wire everything together

**Files:**
- Create: `src/agents/test-agent/test-agent.ts`

- [ ] **Step 1: Write test-agent.ts**

```typescript
// src/agents/test-agent/test-agent.ts
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

  /**
   * Run the full test pipeline for a ticket:
   * 1. Checkout ticket branch
   * 2. Spawn test agent pi process to write tests
   * 3. Run the test suite
   * 4. Parse results and return TestResult
   */
  async execute(ticket: Ticket, memoryContext: string[]): Promise<TestResult> {
    const agentId = `test-${ticket.id}-${Date.now()}`;

    // 1. Checkout ticket branch
    try {
      execSync(`git checkout "${ticket.git_branch}"`, {
        cwd: this.config.workspacePath,
        stdio: 'pipe',
      });
    } catch {
      return this.errorResult(ticket.git_branch!, 'Failed to checkout ticket branch');
    }

    // 2. Spawn test agent pi process to write tests
    const prompt = buildTestPrompt(ticket, memoryContext);
    try {
      const proc = this.pool.spawnEphemeral(agentId, this.config.sessionId, this.config.memoryDbPath, 'test', {
        AELVYRIL_TICKET_ID: ticket.id,
        AELVYRIL_TICKET_PROMPT: prompt,
        AELVYRIL_WORKSPACE: this.config.workspacePath,
      });

      // Wait for test agent to finish writing tests (simplified — in production, poll for completion)
      await new Promise(resolve => {
        const check = setInterval(() => {
          if (!proc.isRunning()) {
            clearInterval(check);
            resolve(undefined);
          }
        }, 1000);
        // Timeout after 5 minutes
        setTimeout(() => {
          clearInterval(check);
          proc.kill();
          resolve(undefined);
        }, 300000);
      });
    } catch {
      // Continue to run tests even if agent had issues — tests may already be written
    }

    // 3. Run the test suite
    let runResult: TestRunResult;
    try {
      runResult = await runTests(this.config.workspacePath, {
        timeoutMs: this.config.testTimeoutMs ?? 120000,
      });
    } catch {
      return this.errorResult(ticket.git_branch!, 'Test runner failed to execute');
    }

    // 4. Parse results
    const result = parseVitestOutput(runResult.output, ticket.git_branch!);

    // 5. Update board with test results
    this.board.setTestResults(ticket.id, result);

    // 6. Track cost (approximate — test agent + test runner)
    const tokensEstimate = prompt.length / 4; // Rough char-to-token estimate
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
```

- [ ] **Step 2: Commit**

```bash
git add src/agents/test-agent/test-agent.ts
git commit -m "feat: test agent orchestrator — spawn pi process, write tests, run suite, parse results"
```

---

### Task 5: Run all Phase 8 tests

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL TESTS PASS (Phase 1-8)

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "chore: Phase 8 complete — test agent with result parser, runner, prompt builder, orchestrator"
```
