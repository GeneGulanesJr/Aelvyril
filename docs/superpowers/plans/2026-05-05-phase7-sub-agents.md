# Phase 7: Sub-Agents — Ticket Execution in Git Branches

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement sub-agent spawning and execution. Each sub-agent is an ephemeral pi process that receives one ticket, checks out the ticket's git branch, does the work, commits changes, and reports back. Sub-agents are isolated by git branches — no two share a branch.

**Architecture:** Sub-agents are spawned by the Main Agent via the AgentPool. Each gets environment variables pointing to the session's memory DB, the ticket ID, and the workspace path. The sub-agent pi process receives a prompt built from the ticket's description + acceptance criteria + relevant PiMemory context. On completion, the sub-agent auto-commits and the Main Agent is notified.

**Tech Stack:** pi, PiMemoryExtension, git

**Spec reference:** `docs/superpowers/specs/2026-05-05-cloud-platform-design.md` §3.2 (Sub-agents role), §3.7 (Git strategy)

**Depends on:** Phase 1-6

---

## File Structure

```
src/
├── agents/
│   ├── sub-agent/
│   │   ├── sub-agent-spawner.ts  # Build prompt + spawn sub-agent pi process
│   │   └── sub-agent-prompt.ts   # Build ticket-specific prompt
tests/
├── agents/
│   └── sub-agent/
│       └── sub-agent-prompt.test.ts
```

---

### Task 1: Sub-agent prompt builder

**Files:**
- Create: `src/agents/sub-agent/sub-agent-prompt.ts`
- Test: `tests/agents/sub-agent/sub-agent-prompt.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { buildSubAgentPrompt } from '../../src/agents/sub-agent/sub-agent-prompt.js';
import type { Ticket } from '../../src/types/common.js';

const baseTicket: Ticket = {
  id: '#1', session_id: 'test', title: 'Add dark mode toggle',
  description: 'Add a toggle component that switches between light and dark themes',
  acceptance_criteria: ['Toggle component renders', 'Clicking toggle switches theme', 'Theme persists'],
  dependencies: [], files: ['src/Toggle.tsx', 'src/theme.tsx'], priority: 1,
  status: 'in_progress', assigned_agent: 'sub-1', test_results: null,
  review_notes: null, reject_count: 0, held_reason: null,
  git_branch: 'aelvyril/ticket-#1', cost_tokens: 0, cost_usd: 0,
  created_at: '', updated_at: '',
};

describe('buildSubAgentPrompt', () => {
  it('includes ticket title and description', () => {
    const prompt = buildSubAgentPrompt(baseTicket, []);
    expect(prompt).toContain('Add dark mode toggle');
    expect(prompt).toContain('Add a toggle component');
  });

  it('includes acceptance criteria', () => {
    const prompt = buildSubAgentPrompt(baseTicket, []);
    expect(prompt).toContain('Toggle component renders');
    expect(prompt).toContain('Theme persists');
  });

  it('includes files to touch', () => {
    const prompt = buildSubAgentPrompt(baseTicket, []);
    expect(prompt).toContain('src/Toggle.tsx');
    expect(prompt).toContain('src/theme.tsx');
  });

  it('includes memory context', () => {
    const prompt = buildSubAgentPrompt(baseTicket, ['Memory: Uses CSS variables for theming']);
    expect(prompt).toContain('CSS variables');
  });

  it('includes git branch info', () => {
    const prompt = buildSubAgentPrompt(baseTicket, []);
    expect(prompt).toContain('aelvyril/ticket-#1');
  });
});
```

- [ ] **Step 2: Run test → FAIL**

- [ ] **Step 3: Write sub-agent-prompt.ts**

```typescript
// src/agents/sub-agent/sub-agent-prompt.ts
import type { Ticket } from '../../types/common.js';

export function buildSubAgentPrompt(ticket: Ticket, memoryContext: string[]): string {
  const contextBlock = memoryContext.length > 0
    ? `\n## Context from Memory\n${memoryContext.map(m => `- ${m}`).join('\n')}\n`
    : '';

  return `You are a Sub-Agent for Aelvyril. You have been assigned ONE ticket.

## Ticket #${ticket.id}: ${ticket.title}
${ticket.description}

## Files to Modify
${ticket.files.map(f => `- ${f}`).join('\n')}

## Acceptance Criteria
${ticket.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}
${contextBlock}
## Git Branch
You are working on branch: \`${ticket.git_branch}\`

## Rules
1. ONLY modify the files listed above
2. After completing work, stage and commit all changes with: \`git commit -m "ticket(${ticket.id}): ${ticket.title}"\`
3. Ensure all acceptance criteria are met
4. Do NOT modify any other files
5. Do NOT run tests — that is handled by the Test Agent
6. Save any important discoveries to memory

When done, output a single JSON object:
\`\`\`json
{
  "status": "complete",
  "files_modified": ["list", "of", "files"],
  "summary": "what was done"
}
\`\`\``;
}
```

- [ ] **Step 4: Run test → PASS**

- [ ] **Step 5: Commit**

```bash
git add src/agents/sub-agent/ tests/agents/sub-agent/
git commit -m "feat: sub-agent prompt builder — ticket-specific prompt with files, criteria, memory context"
```

---

### Task 2: Sub-agent spawner

**Files:**
- Create: `src/agents/sub-agent/sub-agent-spawner.ts`

- [ ] **Step 1: Write sub-agent-spawner.ts**

```typescript
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
      AELVYRIL_WORKSPACE: '', // Set by orchestrator
    });

    return agentId;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agents/sub-agent/sub-agent-spawner.ts
git commit -m "feat: sub-agent spawner — create ephemeral pi process per ticket"
```

---

### Task 3: Run all Phase 7 tests

- [ ] **Step 1:** Run: `npx vitest run` → ALL PASS
- [ ] **Step 2:** Commit: `chore: Phase 7 complete — sub-agents with prompt builder and spawner`
