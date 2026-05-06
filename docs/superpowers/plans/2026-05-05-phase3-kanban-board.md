# Phase 3: Kanban Board — Ticket CRUD, Concurrency Plan, Board State

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Kanban board data layer — create/read/update tickets, store concurrency plans, transition ticket states through the 5-column pipeline (Backlog → In Progress → Testing → In Review → Done + Held), persist everything to SQLite.

**Architecture:** The BoardManager owns the board state for a session. Tickets are rows in the `tickets` table. The ConcurrencyPlan is a JSON blob in `concurrency_plans`. Every state change is an immediate synchronous SQLite write (crash safe). Board state is exposed via WebSocket events.

**Tech Stack:** SQLite, TypeScript

**Spec reference:** `docs/superpowers/specs/2026-05-05-cloud-platform-design.md` §3.5, §3.6

**Depends on:** Phase 1 (Orchestrator Foundation)

---

## File Structure

```
src/
├── board/
│   ├── board-manager.ts       # Board CRUD, state transitions, concurrency plan
│   └── board-events.ts        # WebSocket event emitter for board state changes
tests/
├── board/
│   └── board-manager.test.ts
```

---

### Task 1: Board Manager — ticket CRUD

**Files:**
- Create: `src/board/board-manager.ts`
- Test: `tests/board/board-manager.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/board/board-manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BoardManager } from '../../src/board/board-manager.js';
import { Database } from '../../src/db/database.js';
import { SessionManager } from '../../src/sessions/session-manager.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('BoardManager', () => {
  let db: Database;
  let bm: BoardManager;
  let sessionId: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-board-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    const sm = new SessionManager(db, tmpDir);
    const session = sm.create('https://github.com/test/repo.git');
    sessionId = session.id;
    bm = new BoardManager(db, sessionId);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a ticket', () => {
    const ticket = bm.createTicket({
      title: 'Add dark mode',
      description: 'Add dark mode toggle to settings',
      acceptance_criteria: ['Toggle exists', 'Theme persists'],
      dependencies: [],
      files: ['src/theme.tsx', 'src/settings.tsx'],
      priority: 1,
    });
    expect(ticket.id).toBe('#1');
    expect(ticket.status).toBe('backlog');
  });

  it('auto-increments ticket IDs', () => {
    bm.createTicket({ title: 'Task A', description: '', acceptance_criteria: [], dependencies: [], files: [], priority: 1 });
    bm.createTicket({ title: 'Task B', description: '', acceptance_criteria: [], dependencies: [], files: [], priority: 2 });
    const tickets = bm.getTickets();
    expect(tickets[0].id).toBe('#2'); // Most recent first
    expect(tickets[1].id).toBe('#1');
  });

  it('transitions ticket through the pipeline', () => {
    const t = bm.createTicket({ title: 'Test', description: '', acceptance_criteria: [], dependencies: [], files: [], priority: 1 });
    bm.transition(t.id, 'in_progress');
    expect(bm.getTicket(t.id)!.status).toBe('in_progress');
    bm.transition(t.id, 'testing');
    expect(bm.getTicket(t.id)!.status).toBe('testing');
    bm.transition(t.id, 'in_review');
    expect(bm.getTicket(t.id)!.status).toBe('in_review');
    bm.transition(t.id, 'done');
    expect(bm.getTicket(t.id)!.status).toBe('done');
  });

  it('moves to held state with reason', () => {
    const t = bm.createTicket({ title: 'Test', description: '', acceptance_criteria: [], dependencies: [], files: [], priority: 1 });
    bm.transition(t.id, 'in_progress');
    bm.hold(t.id, 'LLM API rate limit');
    const ticket = bm.getTicket(t.id);
    expect(ticket!.status).toBe('held');
    expect(ticket!.held_reason).toBe('LLM API rate limit');
  });

  it('releases held ticket back to previous state', () => {
    const t = bm.createTicket({ title: 'Test', description: '', acceptance_criteria: [], dependencies: [], files: [], priority: 1 });
    bm.transition(t.id, 'in_progress');
    bm.hold(t.id, 'API down');
    bm.release(t.id);
    expect(bm.getTicket(t.id)!.status).toBe('in_progress');
    expect(bm.getTicket(t.id)!.held_reason).toBeNull();
  });

  it('rejects and increments reject count', () => {
    const t = bm.createTicket({ title: 'Test', description: '', acceptance_criteria: [], dependencies: [], files: [], priority: 1 });
    bm.transition(t.id, 'in_progress');
    bm.transition(t.id, 'testing');
    bm.transition(t.id, 'in_review');
    bm.reject(t.id, 'Missing error handling');
    const ticket = bm.getTicket(t.id);
    expect(ticket!.status).toBe('backlog');
    expect(ticket!.reject_count).toBe(1);
    expect(ticket!.review_notes).toBe('Missing error handling');
  });

  it('stores and retrieves concurrency plan', () => {
    bm.saveConcurrencyPlan({
      max_parallel: 2,
      waves: [['#1', '#3'], ['#2']],
      conflict_groups: [['#1', '#2']],
    });
    const plan = bm.getConcurrencyPlan();
    expect(plan).not.toBeNull();
    expect(plan!.max_parallel).toBe(2);
    expect(plan!.waves).toEqual([['#1', '#3'], ['#2']]);
  });

  it('finds tickets by status', () => {
    bm.createTicket({ title: 'A', description: '', acceptance_criteria: [], dependencies: [], files: [], priority: 1 });
    const t2 = bm.createTicket({ title: 'B', description: '', acceptance_criteria: [], dependencies: [], files: [], priority: 2 });
    bm.transition(t2.id, 'in_progress');
    expect(bm.getTicketsByStatus('backlog')).toHaveLength(1);
    expect(bm.getTicketsByStatus('in_progress')).toHaveLength(1);
  });

  it('tracks cumulative cost across retries', () => {
    const t = bm.createTicket({ title: 'Test', description: '', acceptance_criteria: [], dependencies: [], files: [], priority: 1 });
    bm.addCost(t.id, 1000, 0.05);
    bm.addCost(t.id, 2000, 0.10);
    const ticket = bm.getTicket(t.id);
    expect(ticket!.cost_tokens).toBe(3000);
    expect(ticket!.cost_usd).toBeCloseTo(0.15);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/board/board-manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write board-manager.ts**

```typescript
// src/board/board-manager.ts
import type { Database } from '../db/database.js';
import type { Ticket, TicketStatus, ConcurrencyPlan, TestResult } from '../types/common.js';

interface CreateTicketInput {
  title: string;
  description: string;
  acceptance_criteria: string[];
  dependencies: string[];
  files: string[];
  priority: number;
}

export class BoardManager {
  private ticketCounter: number;

  constructor(
    private db: Database,
    private sessionId: string
  ) {
    // Initialize counter from existing tickets
    const rows = this.db.raw.prepare(
      'SELECT id FROM tickets WHERE session_id = ? ORDER BY id DESC LIMIT 1'
    ).all(sessionId) as { id: string }[];
    if (rows.length > 0) {
      this.ticketCounter = parseInt(rows[0].id.replace('#', ''), 10);
    } else {
      this.ticketCounter = 0;
    }
  }

  createTicket(input: CreateTicketInput): Ticket {
    this.ticketCounter++;
    const id = `#${this.ticketCounter}`;
    const now = new Date().toISOString();

    this.db.raw.prepare(`
      INSERT INTO tickets (id, session_id, title, description, acceptance_criteria, dependencies, files, priority, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'backlog', ?, ?)
    `).run(
      id, this.sessionId, input.title, input.description,
      JSON.stringify(input.acceptance_criteria),
      JSON.stringify(input.dependencies),
      JSON.stringify(input.files),
      input.priority, now, now
    );

    return this.getTicket(id)!;
  }

  getTicket(id: string): Ticket | null {
    const row = this.db.raw.prepare(
      'SELECT * FROM tickets WHERE id = ? AND session_id = ?'
    ).get(id, this.sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToTicket(row);
  }

  getTickets(): Ticket[] {
    const rows = this.db.raw.prepare(
      'SELECT * FROM tickets WHERE session_id = ? ORDER BY priority DESC, created_at ASC'
    ).all(this.sessionId) as Record<string, unknown>[];
    return rows.map(r => this.rowToTicket(r));
  }

  getTicketsByStatus(status: TicketStatus): Ticket[] {
    const rows = this.db.raw.prepare(
      'SELECT * FROM tickets WHERE session_id = ? AND status = ?'
    ).all(this.sessionId, status) as Record<string, unknown>[];
    return rows.map(r => this.rowToTicket(r));
  }

  transition(id: string, status: TicketStatus): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(
      'UPDATE tickets SET status = ?, updated_at = ? WHERE id = ? AND session_id = ?'
    ).run(status, now, id, this.sessionId);
  }

  hold(id: string, reason: string): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(
      "UPDATE tickets SET status = 'held', held_reason = ?, updated_at = ? WHERE id = ? AND session_id = ?"
    ).run(reason, now, id, this.sessionId);
  }

  release(id: string): void {
    // Move back to in_progress as default release target
    const now = new Date().toISOString();
    this.db.raw.prepare(
      "UPDATE tickets SET status = 'in_progress', held_reason = NULL, updated_at = ? WHERE id = ? AND session_id = ?"
    ).run(now, id, this.sessionId);
  }

  reject(id: string, notes: string): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(`
      UPDATE tickets SET status = 'backlog', review_notes = ?, reject_count = reject_count + 1, updated_at = ?
      WHERE id = ? AND session_id = ?
    `).run(notes, now, id, this.sessionId);
  }

  setTestResults(id: string, results: TestResult): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(
      'UPDATE tickets SET test_results = ?, updated_at = ? WHERE id = ? AND session_id = ?'
    ).run(JSON.stringify(results), now, id, this.sessionId);
  }

  assignAgent(id: string, agentId: string | null): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(
      'UPDATE tickets SET assigned_agent = ?, updated_at = ? WHERE id = ? AND session_id = ?'
    ).run(agentId, now, id, this.sessionId);
  }

  addCost(id: string, tokens: number, costUsd: number): void {
    this.db.raw.prepare(`
      UPDATE tickets SET cost_tokens = cost_tokens + ?, cost_usd = cost_usd + ?, updated_at = ?
      WHERE id = ? AND session_id = ?
    `).run(tokens, costUsd, new Date().toISOString(), id, this.sessionId);
  }

  saveConcurrencyPlan(plan: ConcurrencyPlan): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(`
      INSERT INTO concurrency_plans (session_id, plan_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET plan_json = ?, updated_at = ?
    `).run(this.sessionId, JSON.stringify(plan), now, now, JSON.stringify(plan), now);
  }

  getConcurrencyPlan(): ConcurrencyPlan | null {
    const row = this.db.raw.prepare(
      'SELECT plan_json FROM concurrency_plans WHERE session_id = ?'
    ).get(this.sessionId) as { plan_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.plan_json);
  }

  private rowToTicket(row: Record<string, unknown>): Ticket {
    return {
      id: row.id as string,
      session_id: row.session_id as string,
      title: row.title as string,
      description: row.description as string,
      acceptance_criteria: JSON.parse(row.acceptance_criteria as string || '[]'),
      dependencies: JSON.parse(row.dependencies as string || '[]'),
      files: JSON.parse(row.files as string || '[]'),
      priority: row.priority as number,
      status: row.status as TicketStatus,
      assigned_agent: row.assigned_agent as string | null,
      test_results: row.test_results ? JSON.parse(row.test_results as string) : null,
      review_notes: row.review_notes as string | null,
      reject_count: row.reject_count as number,
      held_reason: row.held_reason as string | null,
      git_branch: row.git_branch as string | null,
      cost_tokens: row.cost_tokens as number,
      cost_usd: row.cost_usd as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/board/board-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/board/ tests/board/
git commit -m "feat: board manager — ticket CRUD, 5-column pipeline transitions, held state, concurrency plan, cost tracking"
```

---

### Task 2: Board events (WebSocket broadcast)

**Files:**
- Create: `src/board/board-events.ts`

- [ ] **Step 1: Write board-events.ts**

```typescript
// src/board/board-events.ts
import type { Server } from 'ws';
import type { Ticket, BoardState } from '../types/common.js';

type BoardEventCallback = (event: string, data: unknown) => void;

export class BoardEvents {
  private callbacks: BoardEventCallback[] = [];

  onBoardChange(callback: BoardEventCallback): void {
    this.callbacks.push(callback);
  }

  emitTicketCreated(ticket: Ticket): void {
    this.emit('ticket_created', ticket);
  }

  emitTicketTransition(ticketId: string, from: string, to: string): void {
    this.emit('ticket_transition', { ticket_id: ticketId, from, to });
  }

  emitTicketHeld(ticketId: string, reason: string): void {
    this.emit('ticket_held', { ticket_id: ticketId, reason });
  }

  emitTicketReleased(ticketId: string): void {
    this.emit('ticket_released', { ticket_id: ticketId });
  }

  emitBoardState(state: BoardState): void {
    this.emit('board_state', state);
  }

  private emit(event: string, data: unknown): void {
    const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
    for (const cb of this.callbacks) {
      cb(event, message);
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/board/board-events.ts
git commit -m "feat: board events — WebSocket broadcast for ticket state changes"
```

---

### Task 3: Run all Phase 3 tests

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL TESTS PASS (Phase 1 + 2 + 3)

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "chore: Phase 3 complete — kanban board with ticket CRUD, pipeline transitions, concurrency plans"
```
