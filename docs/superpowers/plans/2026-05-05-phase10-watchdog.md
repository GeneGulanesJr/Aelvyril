# Phase 10: Watchdog Agent — Heartbeat, Stuck Detection, Intervention

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Watchdog Agent — a long-running agent that polls the board every 5 seconds, detects stuck tickets, and intervenes using LLM when 5+ minutes pass with no state change. Handles held state for API failures, escalation to user after repeated rejections, and crash recovery (re-dispatch stale tickets).

**Architecture:** The Watchdog runs a setInterval loop. On each tick, it checks every ticket's `updated_at`. If no activity for 5+ min, it invokes LLM to analyze and decide action (re-scope, retry, break deadlock, escalate). For API failures, moves tickets to Held. For crashes, re-dispatches. The Watchdog also sends real-time progress reports via WebSocket.

**Tech Stack:** setInterval, LLM (conditional), BoardManager, AgentPool, WebSocket

**Spec reference:** `docs/superpowers/specs/2026-05-05-cloud-platform-design.md` §4.1–4.4

**Depends on:** Phase 1-9

---

## File Structure

```
src/
├── agents/
│   ├── watchdog/
│   │   ├── watchdog-agent.ts     # Main watchdog loop
│   │   ├── stuck-detector.ts     # Detect tickets with no activity
│   │   ├── intervention.ts       # LLM-based intervention decisions
│   │   └── progress-reporter.ts  # WebSocket progress broadcasts
tests/
├── agents/
│   └── watchdog/
│       ├── stuck-detector.test.ts
│       └── progress-reporter.test.ts
```

### Task 1: Stuck detector

**Files:**
- Create: `src/agents/watchdog/stuck-detector.ts`
- Test: `tests/agents/watchdog/stuck-detector.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { detectStuckTickets } from '../../src/agents/watchdog/stuck-detector.js';
import type { Ticket } from '../../src/types/common.js';

describe('detectStuckTickets', () => {
  it('returns empty when all tickets have recent activity', () => {
    const now = new Date().toISOString();
    const tickets = [makeTicket('#1', 'in_progress', now)];
    expect(detectStuckTickets(tickets, 300000)).toEqual([]);
  });

  it('detects ticket with no activity for 5+ minutes', () => {
    const fiveMinAgo = new Date(Date.now() - 310000).toISOString();
    const tickets = [makeTicket('#1', 'in_progress', fiveMinAgo)];
    const stuck = detectStuckTickets(tickets, 300000);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].ticket_id).toBe('#1');
  });

  it('ignores done and held tickets', () => {
    const old = new Date(Date.now() - 600000).toISOString();
    const tickets = [
      makeTicket('#1', 'done', old),
      makeTicket('#2', 'held', old),
      makeTicket('#3', 'backlog', old),
    ];
    const stuck = detectStuckTickets(tickets, 300000);
    expect(stuck).toHaveLength(1); // Only #3
  });

  it('detects tickets that exceeded reject threshold', () => {
    const now = new Date().toISOString();
    const tickets = [makeTicket('#1', 'backlog', now, 3)];
    const stuck = detectStuckTickets(tickets, 300000);
    expect(stuck[0].reason).toBe('reject_threshold');
  });
});

function makeTicket(id: string, status: TicketStatus, updatedAt: string, rejectCount = 0): Ticket {
  return {
    id, session_id: 'test', title: id, description: '', acceptance_criteria: [],
    dependencies: [], files: [], priority: 1, status, assigned_agent: null,
    test_results: null, review_notes: null, reject_count: rejectCount, held_reason: null,
    git_branch: null, cost_tokens: 0, cost_usd: 0, created_at: '', updated_at: updatedAt,
  };
}
```

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Write stuck-detector.ts**
- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit**

### Task 2: Intervention logic
- [ ] Write failing test → implement LLM intervention decisions → pass → commit

### Task 3: Progress reporter (WebSocket broadcasts)
- [ ] Write failing test → implement → pass → commit

### Task 4: Watchdog main loop (setInterval)
- [ ] Implement the main watchdog agent with 5s interval → commit

### Task 5: Run all Phase 10 tests
- [ ] Run: `npx vitest run` → ALL PASS → commit
