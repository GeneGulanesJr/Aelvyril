import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Database } from '../../src/db/database.js';
import { BoardManager } from '../../src/board/board-manager.js';
import { SessionManager } from '../../src/sessions/session-manager.js';
import { detectStuckTickets } from '../../src/agents/watchdog/stuck-detector.js';

describe('Crash recovery', () => {
  let db: Database;
  let board: BoardManager;
  let tmpDir: string;
  let sessionId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-crash-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    const sm = new SessionManager(db, path.join(tmpDir, 'workspaces'));
    const session = sm.create('/tmp/fake-repo');
    sessionId = session.id;
    board = new BoardManager(db, sessionId);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('recovers tickets that were in_progress when crash happened', () => {
    board.createTicket({ title: 'Task A', description: '', acceptance_criteria: ['Done'], dependencies: [], files: ['a.ts'], priority: 1 });
    board.createTicket({ title: 'Task B', description: '', acceptance_criteria: ['Done'], dependencies: [], files: ['b.ts'], priority: 2 });

    board.transition('#1', 'in_progress');
    board.assignAgent('#1', 'sub-1');

    const recoveredBoard = new BoardManager(db, sessionId);

    const t1 = recoveredBoard.getTicket('#1');
    expect(t1!.status).toBe('in_progress');
    expect(t1!.assigned_agent).toBe('sub-1');

    const stuck = detectStuckTickets(recoveredBoard.getTickets(), {
      stallThresholdMs: 0,
      progressStallMs: 0,
    });
    expect(stuck.some(s => s.ticket_id === '#1')).toBe(true);
  });

  it('recovers tickets that were in testing when crash happened', () => {
    board.createTicket({ title: 'Task A', description: '', acceptance_criteria: ['Done'], dependencies: [], files: ['a.ts'], priority: 1 });
    board.transition('#1', 'in_progress');
    board.transition('#1', 'testing');

    const recoveredBoard = new BoardManager(db, sessionId);
    const t1 = recoveredBoard.getTicket('#1');
    expect(t1!.status).toBe('testing');
  });

  it('preserves concurrency plan across restart', () => {
    board.createTicket({ title: 'Task A', description: '', acceptance_criteria: ['Done'], dependencies: [], files: ['a.ts'], priority: 1 });
    board.saveConcurrencyPlan({
      max_parallel: 2,
      waves: [['#1']],
      conflict_groups: [],
    });

    const recoveredBoard = new BoardManager(db, sessionId);
    const plan = recoveredBoard.getConcurrencyPlan();
    expect(plan).not.toBeNull();
    expect(plan!.max_parallel).toBe(2);
  });
});
