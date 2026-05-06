# Phase 6: Main Agent — Ticket Dispatch and Wave Execution

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Main Agent — a long-running agent that picks tickets from the board, dispatches sub-agents according to the concurrency plan, manages wave execution (parallel when independent, sequential when dependent), handles git branching, and auto-creates PRs + merges when all tickets are done.

**Architecture:** The Main Agent is a long-running pi process per session. It watches the board for unblocked tickets, reads the concurrency plan, spawns sub-agent pi processes, waits for completion, triggers Test Agent → Review Agent pipeline, and advances waves. It also handles the final git operations (PR creation, auto-merge).

**Tech Stack:** pi, AgentPool, BoardManager, WorkspaceManager

**Spec reference:** `docs/superpowers/specs/2026-05-05-cloud-platform-design.md` §3.2 (Main Agent role), §3.7 (Git strategy)

**Depends on:** Phase 1-5

---

## File Structure

```
src/
├── agents/
│   ├── main-agent/
│   │   ├── main-agent.ts        # Main agent orchestration loop
│   │   ├── wave-executor.ts     # Execute waves according to concurrency plan
│   │   └── git-operations.ts    # Branch/merge/PR operations
tests/
├── agents/
│   ├── main-agent/
│   │   ├── wave-executor.test.ts
│   │   └── git-operations.test.ts
```

---

### Task 1: Wave executor — determine which tickets can run now

**Files:**
- Create: `src/agents/main-agent/wave-executor.ts`
- Test: `tests/agents/main-agent/wave-executor.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agents/main-agent/wave-executor.test.ts
import { describe, it, expect } from 'vitest';
import { getNextDispatchable } from '../../src/agents/main-agent/wave-executor.js';
import type { Ticket, ConcurrencyPlan } from '../../src/types/common.js';

describe('getNextDispatchable', () => {
  it('returns first wave when no tickets are done', () => {
    const tickets: Ticket[] = [
      makeTicket('#1', 'backlog', []),
      makeTicket('#2', 'backlog', ['#1']),
      makeTicket('#3', 'backlog', []),
    ];
    const plan: ConcurrencyPlan = {
      max_parallel: 2,
      waves: [['#1', '#3'], ['#2']],
      conflict_groups: [],
    };
    const result = getNextDispatchable(tickets, plan);
    expect(result).toEqual(['#1', '#3']);
  });

  it('returns second wave when first wave is done', () => {
    const tickets: Ticket[] = [
      makeTicket('#1', 'done', []),
      makeTicket('#2', 'backlog', ['#1']),
      makeTicket('#3', 'done', []),
    ];
    const plan: ConcurrencyPlan = {
      max_parallel: 2,
      waves: [['#1', '#3'], ['#2']],
      conflict_groups: [],
    };
    const result = getNextDispatchable(tickets, plan);
    expect(result).toEqual(['#2']);
  });

  it('returns empty when all are done', () => {
    const tickets: Ticket[] = [
      makeTicket('#1', 'done', []),
      makeTicket('#2', 'done', ['#1']),
    ];
    const plan: ConcurrencyPlan = {
      max_parallel: 2,
      waves: [['#1'], ['#2']],
      conflict_groups: [],
    };
    const result = getNextDispatchable(tickets, plan);
    expect(result).toEqual([]);
  });

  it('respects max_parallel limit', () => {
    const tickets: Ticket[] = [
      makeTicket('#1', 'backlog', []),
      makeTicket('#2', 'backlog', []),
      makeTicket('#3', 'backlog', []),
    ];
    const plan: ConcurrencyPlan = {
      max_parallel: 2,
      waves: [['#1', '#2', '#3']],
      conflict_groups: [],
    };
    const result = getNextDispatchable(tickets, plan, 1); // 1 already running
    expect(result).toHaveLength(1); // Only 1 more allowed (max_parallel=2, 1 running)
  });
});

function makeTicket(id: string, status: TicketStatus, deps: string[]): Ticket {
  return {
    id, session_id: 'test', title: id, description: '',
    acceptance_criteria: [], dependencies: deps, files: [`file_${id}.ts`],
    priority: 1, status, assigned_agent: null, test_results: null,
    review_notes: null, reject_count: 0, held_reason: null,
    git_branch: null, cost_tokens: 0, cost_usd: 0,
    created_at: '', updated_at: '',
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agents/main-agent/wave-executor.test.ts`
Expected: FAIL

- [ ] **Step 3: Write wave-executor.ts**

```typescript
// src/agents/main-agent/wave-executor.ts
import type { Ticket, ConcurrencyPlan, TicketStatus } from '../../types/common.js';

export function getNextDispatchable(
  tickets: Ticket[],
  plan: ConcurrencyPlan,
  currentlyRunning: number = 0
): string[] {
  const ticketMap = new Map(tickets.map(t => [t.id, t]));
  const dispatchable: string[] = [];
  let slotsAvailable = plan.max_parallel - currentlyRunning;

  for (const wave of plan.waves) {
    const waveAllDone = wave.every(id => ticketMap.get(id)?.status === 'done');
    if (waveAllDone) continue; // Skip completed waves

    for (const ticketId of wave) {
      if (slotsAvailable <= 0) break;

      const ticket = ticketMap.get(ticketId);
      if (!ticket || ticket.status !== 'backlog') continue;

      // Check all dependencies are done
      const depsDone = ticket.dependencies.every(depId => {
        const dep = ticketMap.get(depId);
        return dep?.status === 'done';
      });

      if (depsDone) {
        dispatchable.push(ticketId);
        slotsAvailable--;
      }
    }

    // Only process one incomplete wave at a time
    break;
  }

  return dispatchable;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agents/main-agent/wave-executor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/main-agent/ tests/agents/main-agent/
git commit -m "feat: wave executor — determine dispatchable tickets from concurrency plan"
```

---

### Task 2: Git operations helper

**Files:**
- Create: `src/agents/main-agent/git-operations.ts`

- [ ] **Step 1: Write git-operations.ts**

```typescript
// src/agents/main-agent/git-operations.ts
import { execSync } from 'child_process';

export function createTicketBranch(workspace: string, ticketId: string, sessionId: string): void {
  const sessionBranch = `aelvyril/session-${sessionId}`;
  const ticketBranch = `aelvyril/ticket-${ticketId}`;
  execSync(`git checkout "${sessionBranch}"`, { cwd: workspace, stdio: 'pipe' });
  execSync(`git checkout -b "${ticketBranch}"`, { cwd: workspace, stdio: 'pipe' });
}

export function mergeTicketBranch(workspace: string, ticketId: string, sessionId: string): void {
  const sessionBranch = `aelvyril/session-${sessionId}`;
  const ticketBranch = `aelvyril/ticket-${ticketId}`;
  execSync(`git checkout "${sessionBranch}"`, { cwd: workspace, stdio: 'pipe' });
  execSync(`git merge "${ticketBranch}"`, { cwd: workspace, stdio: 'pipe' });
}

export function resetTicketBranch(workspace: string, ticketId: string, sessionId: string): void {
  const sessionBranch = `aelvyril/session-${sessionId}`;
  const ticketBranch = `aelvyril/ticket-${ticketId}`;
  execSync(`git checkout "${ticketBranch}"`, { cwd: workspace, stdio: 'pipe' });
  execSync(`git reset --hard "${sessionBranch}"`, { cwd: workspace, stdio: 'pipe' });
}

export function createPR(workspace: string, sessionId: string): string {
  const sessionBranch = `aelvyril/session-${sessionId}`;
  execSync(`git push origin "${sessionBranch}"`, { cwd: workspace, stdio: 'pipe' });
  const output = execSync(`gh pr create --fill --head "${sessionBranch}"`, {
    cwd: workspace, stdio: 'pipe',
  }).toString().trim();
  return output; // PR URL
}

export function mergePR(workspace: string, sessionId: string): void {
  const sessionBranch = `aelvyril/session-${sessionId}`;
  execSync(`gh pr merge "${sessionBranch}" --merge`, { cwd: workspace, stdio: 'pipe' });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agents/main-agent/git-operations.ts
git commit -m "feat: git operations — branch/merge/reset/PR for ticket workflow"
```

---

### Task 3: Run all Phase 6 tests

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL TESTS PASS

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "chore: Phase 6 complete — main agent with wave executor and git operations"
```
