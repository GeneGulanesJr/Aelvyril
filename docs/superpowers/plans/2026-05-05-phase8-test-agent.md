# Phase 8: Test Agent — Write Test Cases and Run Full Suite

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Test Agent — an ephemeral agent that writes test cases for a ticket's acceptance criteria AND runs the full test suite. Reports pass/fail with structured results. Pass → ticket moves to In Review. Fail → ticket moves back to In Progress with failure context.

**Architecture:** The Test Agent is spawned after a sub-agent completes work. It receives the ticket ID, checks out the ticket branch, writes test cases covering the acceptance criteria, runs the full test suite, and reports structured results. It uses LLM to generate meaningful tests and reads test patterns from PiMemory.

**Tech Stack:** pi, PiMemoryExtension (reads test patterns), child_process (test runner)

**Spec reference:** `docs/superpowers/specs/2026-05-05-cloud-platform-design.md` §3.2, §3.5 (pipeline flow), TestResult type

**Depends on:** Phase 1-7

---

## File Structure

```
src/
├── agents/
│   ├── test-agent/
│   │   ├── test-agent.ts         # Spawn test agent, collect results
│   │   ├── test-prompt.ts        # Build prompt for test case writing
│   │   ├── test-runner.ts        # Execute test suite and parse results
│   │   └── test-result-parser.ts # Parse test output into TestResult
tests/
├── agents/
│   └── test-agent/
│       ├── test-prompt.test.ts
│       ├── test-runner.test.ts
│       └── test-result-parser.test.ts
```

---

### Task 1: Test result parser

**Files:**
- Create: `src/agents/test-agent/test-result-parser.ts`
- Test: `tests/agents/test-agent/test-result-parser.test.ts`

- [ ] **Step 1: Write failing test for parsing vitest output**

```typescript
import { describe, it, expect } from 'vitest';
import { parseVitestOutput } from '../../src/agents/test-agent/test-result-parser.js';

describe('parseVitestOutput', () => {
  it('parses passing test output', () => {
    const output = `
 ✓ src/Toggle.test.tsx (2 tests) 45ms
 ✓ src/theme.test.tsx (3 tests) 23ms

 Test Files  2 passed (2)
      Tests  5 passed (5)
   Start at  14:23:01
`;
    const result = parseVitestOutput(output, 'aelvyril/ticket-#1');
    expect(result.passed).toBe(true);
    expect(result.total).toBe(5);
    expect(result.passed_count).toBe(5);
    expect(result.failed_count).toBe(0);
  });

  it('parses failing test output', () => {
    const output = `
 ✓ src/theme.test.tsx (3 tests) 23ms
 ✗ src/Toggle.test.tsx (2 tests) 45ms
   × should toggle theme
     → expected "dark" received "light"

 Test Files  1 passed, 1 failed (2)
      Tests  4 passed, 1 failed (5)
`;
    const result = parseVitestOutput(output, 'aelvyril/ticket-#1');
    expect(result.passed).toBe(false);
    expect(result.failed_count).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].test_name).toContain('should toggle theme');
  });
});
```

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Write test-result-parser.ts**
- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit**

### Task 2: Test runner

**Files:**
- Create: `src/agents/test-agent/test-runner.ts`
- Test: `tests/agents/test-agent/test-runner.test.ts`

- [ ] **Step 1: Write failing test**
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Write test-runner.ts — executes `npm test` or `vitest run` in workspace**
- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit**

### Task 3: Test prompt builder

**Files:**
- Create: `src/agents/test-agent/test-prompt.ts`
- Test: `tests/agents/test-agent/test-prompt.test.ts`

- [ ] **Step 1: Write failing test — prompt includes acceptance criteria**
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Write test-prompt.ts**
- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit**

### Task 4: Run all Phase 8 tests

- [ ] **Step 1:** Run: `npx vitest run` → ALL PASS
- [ ] **Step 2:** Commit: `chore: Phase 8 complete — test agent with result parser, runner, prompt builder`
