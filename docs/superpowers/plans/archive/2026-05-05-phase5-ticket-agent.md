# Phase 5: Ticket Agent — Request Decomposition and Concurrency Planning

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Ticket Agent that takes a user request from the Supervisor, breaks it into discrete tickets with dependencies and file lists, and produces a concurrency plan (waves, max parallel, conflict groups). The Ticket Agent is ephemeral — spawned per request, killed after populating the board.

**Architecture:** The Ticket Agent is a pi process spawned by the Orchestrator on Supervisor's request. It receives the user's request + PiMemory context, decomposes into tickets, computes the concurrency plan, writes to the board, and exits. Uses LLM to understand the codebase and plan the work.

**Tech Stack:** pi, PiMemoryExtension (reads codebase knowledge), LLM

**Spec reference:** `docs/superpowers/specs/2026-05-05-cloud-platform-design.md` §3.2 (Ticket Agent role), §3.6 (Concurrency control)

**Depends on:** Phase 1, 2, 3, 4

---

## File Structure

```
src/
├── agents/
│   ├── ticket-agent/
│   │   ├── ticket-agent.ts       # Spawn + communicate with ticket agent pi process
│   │   ├── prompt-builder.ts     # Build the prompt that tells pi how to plan
│   │   └── plan-parser.ts        # Parse pi's response into Ticket[] + ConcurrencyPlan
tests/
├── agents/
│   ├── ticket-agent/
│   │   ├── prompt-builder.test.ts
│   │   └── plan-parser.test.ts
```

---

### Task 1: Prompt builder for Ticket Agent

**Files:**
- Create: `src/agents/ticket-agent/prompt-builder.ts`
- Test: `tests/agents/ticket-agent/prompt-builder.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agents/ticket-agent/prompt-builder.test.ts
import { describe, it, expect } from 'vitest';
import { buildTicketPrompt } from '../../src/agents/ticket-agent/prompt-builder.js';

describe('buildTicketPrompt', () => {
  it('includes the user request', () => {
    const prompt = buildTicketPrompt('Add dark mode toggle to settings', []);
    expect(prompt).toContain('Add dark mode toggle to settings');
  });

  it('includes memory context when provided', () => {
    const prompt = buildTicketPrompt('Add dark mode', [
      'Memory: Theme system uses CSS variables in src/theme.tsx',
      'Memory: Settings page is at src/Settings.tsx',
    ]);
    expect(prompt).toContain('src/theme.tsx');
    expect(prompt).toContain('src/Settings.tsx');
  });

  it('instructs the agent to output JSON', () => {
    const prompt = buildTicketPrompt('Test task', []);
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('tickets');
    expect(prompt).toContain('concurrency');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agents/ticket-agent/prompt-builder.test.ts`
Expected: FAIL

- [ ] **Step 3: Write prompt-builder.ts**

```typescript
// src/agents/ticket-agent/prompt-builder.ts
export function buildTicketPrompt(userRequest: string, memoryContext: string[]): string {
  const contextBlock = memoryContext.length > 0
    ? `\n## Codebase Context (from memory)\n${memoryContext.map(m => `- ${m}`).join('\n')}\n`
    : '';

  return `You are a Ticket Agent for the Aelvyril coding platform. Your job is to break down a user request into discrete, implementable tickets and produce a concurrency plan.

## User Request
${userRequest}
${contextBlock}
## Your Output
Respond with a single JSON object matching this exact schema:

\`\`\`json
{
  "tickets": [
    {
      "title": "short description",
      "description": "full context of what to do",
      "acceptance_criteria": ["criterion 1", "criterion 2"],
      "dependencies": [],
      "files": ["src/path/to/file.ts"],
      "priority": 1
    }
  ],
  "concurrency": {
    "max_parallel": 2,
    "waves": [["#1", "#3"], ["#2"]],
    "conflict_groups": []
  }
}
\`\`\`

## Rules
1. Each ticket MUST list the files it will touch
2. No two tickets in the same wave can share files
3. Dependencies reference ticket IDs in order (e.g., "#2" depends on "#1")
4. Priority: 1 = highest
5. max_parallel should be 2-3 unless the request is trivial (1 ticket) or very large (4+)
6. Split work so each ticket is independently testable and reviewable
7. Every ticket must have clear acceptance criteria

Respond with ONLY the JSON object. No explanation.`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agents/ticket-agent/prompt-builder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/ticket-agent/prompt-builder.ts tests/agents/ticket-agent/prompt-builder.test.ts
git commit -m "feat: ticket agent prompt builder — structured prompt for decomposition + concurrency planning"
```

---

### Task 2: Plan parser — validate and normalize Ticket Agent output

**Files:**
- Create: `src/agents/ticket-agent/plan-parser.ts`
- Test: `tests/agents/ticket-agent/plan-parser.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agents/ticket-agent/plan-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parsePlanResponse } from '../../src/agents/ticket-agent/plan-parser.js';

describe('parsePlanResponse', () => {
  it('parses a valid response', () => {
    const raw = JSON.stringify({
      tickets: [
        { title: 'Add theme context', description: 'Create theme context', acceptance_criteria: ['Context exists'], dependencies: [], files: ['src/theme.tsx'], priority: 1 },
        { title: 'Build toggle', description: 'Build toggle component', acceptance_criteria: ['Toggle renders'], dependencies: ['#1'], files: ['src/Toggle.tsx', 'src/theme.tsx'], priority: 2 },
      ],
      concurrency: { max_parallel: 2, waves: [['#1'], ['#2']], conflict_groups: [] },
    });
    const result = parsePlanResponse(raw);
    expect(result.tickets).toHaveLength(2);
    expect(result.tickets[0].title).toBe('Add theme context');
    expect(result.plan.max_parallel).toBe(2);
  });

  it('rejects response with missing tickets', () => {
    expect(() => parsePlanResponse(JSON.stringify({ concurrency: { max_parallel: 1, waves: [[]], conflict_groups: [] } }))).toThrow('missing tickets');
  });

  it('rejects response with missing concurrency', () => {
    expect(() => parsePlanResponse(JSON.stringify({ tickets: [] }))).toThrow('missing concurrency');
  });

  it('rejects ticket without files', () => {
    const raw = JSON.stringify({
      tickets: [{ title: 'No files', description: '', acceptance_criteria: [], dependencies: [], files: [], priority: 1 }],
      concurrency: { max_parallel: 1, waves: [['#1']], conflict_groups: [] },
    });
    expect(() => parsePlanResponse(raw)).toThrow('must list files');
  });

  it('extracts JSON from markdown code fences', () => {
    const raw = 'Here is the plan:\n```json\n{"tickets":[{"title":"A","description":"B","acceptance_criteria":["C"],"dependencies":[],"files":["f.ts"],"priority":1}],"concurrency":{"max_parallel":1,"waves":[["#1"]],"conflict_groups":[]}}\n```';
    const result = parsePlanResponse(raw);
    expect(result.tickets).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agents/ticket-agent/plan-parser.test.ts`
Expected: FAIL

- [ ] **Step 3: Write plan-parser.ts**

```typescript
// src/agents/ticket-agent/plan-parser.ts

interface RawTicket {
  title: string;
  description: string;
  acceptance_criteria: string[];
  dependencies: string[];
  files: string[];
  priority: number;
}

interface RawConcurrency {
  max_parallel: number;
  waves: string[][];
  conflict_groups: string[][];
}

interface RawPlanResponse {
  tickets: RawTicket[];
  concurrency: RawConcurrency;
}

export interface ParsedPlan {
  tickets: RawTicket[];
  plan: RawConcurrency;
}

export function parsePlanResponse(raw: string): ParsedPlan {
  // Try to extract JSON from markdown code fences
  const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ?? [null, raw];
  const jsonStr = jsonMatch[1] || raw;

  let parsed: RawPlanResponse;
  try {
    parsed = JSON.parse(jsonStr.trim());
  } catch {
    throw new Error('Invalid JSON in ticket agent response');
  }

  if (!parsed.tickets || !Array.isArray(parsed.tickets)) {
    throw new Error('Invalid plan: missing tickets array');
  }
  if (!parsed.concurrency) {
    throw new Error('Invalid plan: missing concurrency');
  }

  // Validate each ticket
  for (const ticket of parsed.tickets) {
    if (!ticket.title) throw new Error('Invalid ticket: missing title');
    if (!ticket.files || ticket.files.length === 0) {
      throw new Error(`Ticket "${ticket.title}" must list files it will touch`);
    }
    if (!ticket.acceptance_criteria || ticket.acceptance_criteria.length === 0) {
      throw new Error(`Ticket "${ticket.title}" must have acceptance criteria`);
    }
  }

  return {
    tickets: parsed.tickets,
    plan: parsed.concurrency,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agents/ticket-agent/plan-parser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/ticket-agent/plan-parser.ts tests/agents/ticket-agent/plan-parser.test.ts
git commit -m "feat: plan parser — validate ticket agent output, extract JSON from markdown"
```

---

### Task 3: Run all Phase 5 tests

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL TESTS PASS

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "chore: Phase 5 complete — ticket agent with prompt builder and plan parser"
```
