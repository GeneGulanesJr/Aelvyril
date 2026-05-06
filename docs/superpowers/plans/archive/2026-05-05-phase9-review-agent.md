# Phase 9: Review Agent — Code Review with Approve/Reject

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Review Agent — an ephemeral agent that reviews completed + tested code changes on a ticket branch. Checks code quality, matches acceptance criteria, reviews for regressions. Approve → ticket moves to Done, branch merged into session branch. Reject → ticket moves to Backlog with review notes, reject_count++.

**Architecture:** The Review Agent is spawned after the Test Agent passes. It receives the ticket ID, gets the git diff between the ticket branch and session branch, reviews against acceptance criteria and codebase conventions stored in PiMemory, and outputs a structured review decision.

**Tech Stack:** pi, PiMemoryExtension (reads conventions), git diff

**Spec reference:** `docs/superpowers/specs/2026-05-05-cloud-platform-design.md` §3.2, §3.5, §3.7

**Depends on:** Phase 1-8

---

## File Structure

```
src/
├── agents/
│   ├── review-agent/
│   │   ├── diff-collector.ts          # Get git diff for ticket branch
│   │   ├── review-prompt.ts           # Build prompt with diff + criteria
│   │   ├── review-decision-parser.ts  # Parse LLM response into ReviewDecision
│   │   └── review-agent.ts            # Spawn, review, approve/reject
tests/
├── agents/
│   └── review-agent/
│       ├── diff-collector.test.ts
│       ├── review-prompt.test.ts
│       └── review-decision-parser.test.ts
```

---

### Task 1: Diff collector — get git diff for a ticket branch

**Files:**
- Create: `src/agents/review-agent/diff-collector.ts`
- Test: `tests/agents/review-agent/diff-collector.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agents/review-agent/diff-collector.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { collectDiff, type DiffResult } from '../../src/agents/review-agent/diff-collector.js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('collectDiff', () => {
  let tmpDir: string;
  let mainBranch: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-diff-'));
    // Init git repo
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });

    // Create base file and commit on main
    fs.writeFileSync(path.join(tmpDir, 'hello.ts'), 'export function hello() { return "world"; }\n');
    execSync('git add .', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "initial"', { cwd: tmpDir, stdio: 'pipe' });
    mainBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir }).toString().trim();

    // Create ticket branch with changes
    execSync('git checkout -b aelvyril/ticket-#1', { cwd: tmpDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(tmpDir, 'hello.ts'), 'export function hello() { return "hello"; }\n');
    fs.writeFileSync(path.join(tmpDir, 'new-file.ts'), 'export const NEW = true;\n');
    execSync('git add .', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "ticket(#1): update hello"', { cwd: tmpDir, stdio: 'pipe' });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('collects diff between ticket branch and base branch', () => {
    const result = collectDiff(tmpDir, 'aelvyril/ticket-#1', mainBranch);
    expect(result.files).toContain('hello.ts');
    expect(result.files).toContain('new-file.ts');
    expect(result.diff).toContain('return "hello"');
    expect(result.diff).toContain('NEW = true');
  });

  it('returns empty diff when no changes', () => {
    // Create a branch with no changes
    execSync(`git checkout ${mainBranch}`, { cwd: tmpDir, stdio: 'pipe' });
    execSync('git checkout -b empty-branch', { cwd: tmpDir, stdio: 'pipe' });

    const result = collectDiff(tmpDir, 'empty-branch', mainBranch);
    expect(result.files).toEqual([]);
    expect(result.diff).toBe('');
  });

  it('throws when branch does not exist', () => {
    expect(() => collectDiff(tmpDir, 'nonexistent-branch', mainBranch)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agents/review-agent/diff-collector.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write diff-collector.ts**

```typescript
// src/agents/review-agent/diff-collector.ts
import { execSync } from 'child_process';

export interface DiffResult {
  files: string[];
  diff: string;
  stats: { additions: number; deletions: number };
}

export function collectDiff(
  workspace: string,
  ticketBranch: string,
  baseBranch: string
): DiffResult {
  // Verify both branches exist
  try {
    execSync(`git rev-parse --verify "${ticketBranch}"`, { cwd: workspace, stdio: 'pipe' });
    execSync(`git rev-parse --verify "${baseBranch}"`, { cwd: workspace, stdio: 'pipe' });
  } catch {
    throw new Error(`Branch not found: ${ticketBranch} or ${baseBranch}`);
  }

  // Get the diff (changes on ticket branch that are not on base)
  let diff: string;
  try {
    diff = execSync(`git diff "${baseBranch}..${ticketBranch}"`, {
      cwd: workspace,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
  } catch {
    throw new Error(`Failed to get diff between ${ticketBranch} and ${baseBranch}`);
  }

  // Extract changed file names
  const files: string[] = [];
  if (diff.trim().length > 0) {
    const fileLines = execSync(`git diff --name-only "${baseBranch}..${ticketBranch}"`, {
      cwd: workspace,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
    if (fileLines) {
      files.push(...fileLines.split('\n'));
    }
  }

  // Get stats (additions/deletions)
  let additions = 0;
  let deletions = 0;
  if (diff.trim().length > 0) {
    const statLine = execSync(`git diff --shortstat "${baseBranch}..${ticketBranch}"`, {
      cwd: workspace,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
    const addMatch = statLine.match(/(\d+) insertion/);
    const delMatch = statLine.match(/(\d+) deletion/);
    additions = addMatch ? parseInt(addMatch[1], 10) : 0;
    deletions = delMatch ? parseInt(delMatch[1], 10) : 0;
  }

  return { files, diff, stats: { additions, deletions } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agents/review-agent/diff-collector.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/review-agent/diff-collector.ts tests/agents/review-agent/diff-collector.test.ts
git commit -m "feat: diff collector — get git diff between ticket and session branch"
```

---

### Task 2: Review prompt builder — build prompt with diff + criteria

**Files:**
- Create: `src/agents/review-agent/review-prompt.ts`
- Test: `tests/agents/review-agent/review-prompt.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agents/review-agent/review-prompt.test.ts
import { describe, it, expect } from 'vitest';
import { buildReviewPrompt } from '../../src/agents/review-agent/review-prompt.js';
import type { Ticket } from '../../src/types/common.js';
import type { DiffResult } from '../../src/agents/review-agent/diff-collector.js';

const baseTicket: Ticket = {
  id: '#1', session_id: 'test', title: 'Add dark mode toggle',
  description: 'Add a toggle component that switches between light and dark themes',
  acceptance_criteria: ['Toggle renders', 'Clicking toggles theme', 'Theme persists'],
  dependencies: [], files: ['src/Toggle.tsx', 'src/theme.tsx'], priority: 1,
  status: 'in_review', assigned_agent: null, test_results: null,
  review_notes: null, reject_count: 0, held_reason: null,
  git_branch: 'aelvyril/ticket-#1', cost_tokens: 0, cost_usd: 0,
  created_at: '', updated_at: '',
};

const baseDiff: DiffResult = {
  files: ['src/Toggle.tsx'],
  diff: 'diff --git a/src/Toggle.tsx\n+export function Toggle() { return <button>Toggle</button> }',
  stats: { additions: 5, deletions: 0 },
};

describe('buildReviewPrompt', () => {
  it('includes ticket title and acceptance criteria', () => {
    const prompt = buildReviewPrompt(baseTicket, baseDiff, []);
    expect(prompt).toContain('Add dark mode toggle');
    expect(prompt).toContain('Toggle renders');
    expect(prompt).toContain('Clicking toggles theme');
    expect(prompt).toContain('Theme persists');
  });

  it('includes the diff', () => {
    const prompt = buildReviewPrompt(baseTicket, baseDiff, []);
    expect(prompt).toContain('Toggle()');
    expect(prompt).toContain('<button>Toggle</button>');
  });

  it('includes changed files list', () => {
    const prompt = buildReviewPrompt(baseTicket, baseDiff, []);
    expect(prompt).toContain('src/Toggle.tsx');
  });

  it('includes diff stats', () => {
    const prompt = buildReviewPrompt(baseTicket, baseDiff, []);
    expect(prompt).toContain('5 additions');
  });

  it('includes memory context (codebase conventions)', () => {
    const prompt = buildReviewPrompt(baseTicket, baseDiff, [
      'Convention: Use PascalCase for React components',
      'Convention: All exports must be named (no default exports)',
    ]);
    expect(prompt).toContain('PascalCase');
    expect(prompt).toContain('named (no default exports)');
  });

  it('includes reject count for re-reviews', () => {
    const ticket = { ...baseTicket, reject_count: 2, review_notes: 'Missing error handling' };
    const prompt = buildReviewPrompt(ticket, baseDiff, []);
    expect(prompt).toContain('2');
    expect(prompt).toContain('Missing error handling');
  });

  it('instructs agent to output JSON ReviewDecision', () => {
    const prompt = buildReviewPrompt(baseTicket, baseDiff, []);
    expect(prompt).toContain('approved');
    expect(prompt).toContain('issues');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agents/review-agent/review-prompt.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write review-prompt.ts**

```typescript
// src/agents/review-agent/review-prompt.ts
import type { Ticket } from '../../types/common.js';
import type { DiffResult } from './diff-collector.js';

export function buildReviewPrompt(
  ticket: Ticket,
  diff: DiffResult,
  memoryContext: string[]
): string {
  const contextBlock = memoryContext.length > 0
    ? `\n## Codebase Conventions (from memory)\n${memoryContext.map(m => `- ${m}`).join('\n')}\n`
    : '';

  const retryBlock = ticket.reject_count > 0
    ? `\n## ⚠ This is re-review #${ticket.reject_count}
Previous feedback: "${ticket.review_notes}"
Address the issues from the previous review.\n`
    : '';

  return `You are a Review Agent for Aelvyril. Review the code changes for this ticket.

## Ticket #${ticket.id}: ${ticket.title}
${ticket.description}

## Acceptance Criteria
${ticket.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## Changed Files
${diff.files.map(f => `- ${f}`).join('\n')}

## Diff Stats
${diff.stats.additions} additions, ${diff.stats.deletions} deletions

## Full Diff
\`\`\`diff
${diff.diff}
\`\`\`
${retryBlock}${contextBlock}
## Review Checklist
1. Does the code meet ALL acceptance criteria?
2. Are there any regressions or side effects?
3. Is error handling sufficient?
4. Are there edge cases not covered?
5. Does the code follow codebase conventions?
6. Are there any performance concerns?
7. Is the code readable and maintainable?

## Your Output
Respond with a single JSON object:
\`\`\`json
{
  "approved": true/false,
  "summary": "Brief summary of the review",
  "notes": "Detailed feedback for the developer",
  "issues": [
    {
      "file": "src/Toggle.tsx",
      "line": 42,
      "severity": "critical|warning|suggestion",
      "message": "Description of the issue"
    }
  ]
}
\`\`\`

If approving: all acceptance criteria must be met, no critical issues.
If rejecting: provide specific, actionable feedback. Never reject with vague feedback like "needs improvement".`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agents/review-agent/review-prompt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/review-agent/review-prompt.ts tests/agents/review-agent/review-prompt.test.ts
git commit -m "feat: review prompt builder — diff, criteria, conventions, re-review context"
```

---

### Task 3: Review decision parser — parse LLM response into ReviewDecision

**Files:**
- Create: `src/agents/review-agent/review-decision-parser.ts`
- Test: `tests/agents/review-agent/review-decision-parser.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agents/review-agent/review-decision-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseReviewDecision } from '../../src/agents/review-agent/review-decision-parser.js';

describe('parseReviewDecision', () => {
  it('parses an approval', () => {
    const raw = JSON.stringify({
      approved: true,
      summary: 'Looks good',
      notes: 'All criteria met, clean code',
      issues: [],
    });
    const decision = parseReviewDecision(raw);
    expect(decision.approved).toBe(true);
    expect(decision.summary).toBe('Looks good');
    expect(decision.issues).toEqual([]);
  });

  it('parses a rejection with issues', () => {
    const raw = JSON.stringify({
      approved: false,
      summary: 'Needs error handling',
      notes: 'Missing try-catch in the API call',
      issues: [
        { file: 'src/api.ts', line: 42, severity: 'critical', message: 'No error handling for network failures' },
        { file: 'src/Toggle.tsx', severity: 'suggestion', message: 'Consider adding aria-label' },
      ],
    });
    const decision = parseReviewDecision(raw);
    expect(decision.approved).toBe(false);
    expect(decision.issues).toHaveLength(2);
    expect(decision.issues[0].severity).toBe('critical');
    expect(decision.issues[1].line).toBeUndefined();
  });

  it('extracts JSON from markdown code fences', () => {
    const raw = 'Here is my review:\n```json\n{"approved":true,"summary":"OK","notes":"","issues":[]}\n```';
    const decision = parseReviewDecision(raw);
    expect(decision.approved).toBe(true);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseReviewDecision('not json')).toThrow('Invalid JSON');
  });

  it('throws when approved field is missing', () => {
    expect(() => parseReviewDecision(JSON.stringify({ summary: 'oops' }))).toThrow('approved');
  });

  it('defaults missing optional fields', () => {
    const decision = parseReviewDecision(JSON.stringify({ approved: true }));
    expect(decision.summary).toBe('');
    expect(decision.notes).toBe('');
    expect(decision.issues).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agents/review-agent/review-decision-parser.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write review-decision-parser.ts**

```typescript
// src/agents/review-agent/review-decision-parser.ts

export interface ReviewIssue {
  file: string;
  line?: number;
  severity: 'critical' | 'warning' | 'suggestion';
  message: string;
}

export interface ReviewDecision {
  approved: boolean;
  summary: string;
  notes: string;
  issues: ReviewIssue[];
}

export function parseReviewDecision(raw: string): ReviewDecision {
  // Extract JSON from markdown code fences
  const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ?? [null, raw];
  const jsonStr = jsonMatch[1] || raw;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr.trim());
  } catch {
    throw new Error('Invalid JSON in review agent response');
  }

  if (typeof parsed.approved !== 'boolean') {
    throw new Error('Review decision missing required "approved" boolean field');
  }

  return {
    approved: parsed.approved,
    summary: (parsed.summary as string) ?? '',
    notes: (parsed.notes as string) ?? '',
    issues: (parsed.issues as ReviewIssue[]) ?? [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agents/review-agent/review-decision-parser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/review-agent/review-decision-parser.ts tests/agents/review-agent/review-decision-parser.test.ts
git commit -m "feat: review decision parser — parse approve/reject with issues from LLM response"
```

---

### Task 4: Review agent orchestrator — spawn, review, decide

**Files:**
- Create: `src/agents/review-agent/review-agent.ts`

- [ ] **Step 1: Write review-agent.ts**

```typescript
// src/agents/review-agent/review-agent.ts
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
    // 1. Collect the diff
    const diff: DiffResult = collectDiff(
      this.config.workspacePath,
      ticket.git_branch!,
      this.config.sessionBranch
    );

    // 2. Build the review prompt
    const prompt = buildReviewPrompt(ticket, diff, memoryContext);

    // 3. Spawn review agent pi process
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

    // 4. Wait for review agent to complete (simplified polling)
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
      }, 300000); // 5 min timeout
    });

    // 5. Parse the decision
    const decision = parseReviewDecision(rawResponse);

    // 6. Execute git action based on decision
    if (decision.approved) {
      mergeTicketBranch(this.config.workspacePath, ticket.id, this.config.sessionId);
      this.board.transition(ticket.id, 'done');
    } else {
      resetTicketBranch(this.config.workspacePath, ticket.id, this.config.sessionId);
      this.board.reject(ticket.id, decision.notes);
    }

    // 7. Track cost
    const tokensEstimate = prompt.length / 4;
    this.board.addCost(ticket.id, tokensEstimate, tokensEstimate * 0.00001);

    return decision;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agents/review-agent/review-agent.ts
git commit -m "feat: review agent orchestrator — spawn, collect diff, parse decision, merge or reject"
```

---

### Task 5: Run all Phase 9 tests

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL TESTS PASS (Phase 1-9)

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "chore: Phase 9 complete — review agent with diff collector, prompt builder, decision parser"
```
