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
    expect(tickets[0].id).toBe('#2');
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

  it('releases held ticket back to in_progress', () => {
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
      tickets: [],
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

  it('rejects invalid transitions', () => {
    const t = bm.createTicket({ title: 'Test', description: '', acceptance_criteria: [], dependencies: [], files: [], priority: 1 });
    expect(() => bm.transition(t.id, 'done')).toThrow('Invalid transition');
    expect(() => bm.transition(t.id, 'testing')).toThrow('Invalid transition');
  });

  it('rejects direct backlog to done', () => {
    const t = bm.createTicket({ title: 'Test', description: '', acceptance_criteria: [], dependencies: [], files: [], priority: 1 });
    expect(() => bm.transition(t.id, 'done')).toThrow();
  });

  it('allows testing back to in_progress on failure', () => {
    const t = bm.createTicket({ title: 'Test', description: '', acceptance_criteria: [], dependencies: [], files: [], priority: 1 });
    bm.transition(t.id, 'in_progress');
    bm.transition(t.id, 'testing');
    bm.transition(t.id, 'in_progress');
    expect(bm.getTicket(t.id)!.status).toBe('in_progress');
  });
});
