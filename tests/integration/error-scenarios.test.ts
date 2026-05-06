import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Database } from '../../src/db/database.js';
import { BoardManager } from '../../src/board/board-manager.js';
import { SessionManager } from '../../src/sessions/session-manager.js';
import { detectStuckTickets } from '../../src/agents/watchdog/stuck-detector.js';

describe('Error scenarios', () => {
  let db: Database;
  let board: BoardManager;
  let tmpDir: string;
  let sessionId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-errors-'));
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

  it('3x reject triggers escalation', () => {
    board.createTicket({ title: 'Stubborn task', description: '', acceptance_criteria: ['Done'], dependencies: [], files: ['a.ts'], priority: 1 });

    for (let i = 0; i < 3; i++) {
      board.transition('#1', 'in_progress');
      board.transition('#1', 'testing');
      board.transition('#1', 'in_review');
      board.reject('#1', `Attempt ${i + 1}: still wrong`);
    }

    const ticket = board.getTicket('#1');
    expect(ticket!.reject_count).toBe(3);

    const stuck = detectStuckTickets(board.getTickets(), {
      stallThresholdMs: 0,
      rejectEscalationThreshold: 3,
    });
    const escalation = stuck.find(s => s.reason === 'reject_threshold');
    expect(escalation).toBeDefined();
    expect(escalation!.ticket_id).toBe('#1');
  });

  it('5x reject triggers hard stop', () => {
    board.createTicket({ title: 'Hopeless task', description: '', acceptance_criteria: ['Done'], dependencies: [], files: ['a.ts'], priority: 1 });

    for (let i = 0; i < 5; i++) {
      board.transition('#1', 'in_progress');
      board.transition('#1', 'testing');
      board.transition('#1', 'in_review');
      board.reject('#1', `Attempt ${i + 1}`);
    }

    const stuck = detectStuckTickets(board.getTickets(), {
      stallThresholdMs: 0,
      rejectHardStopThreshold: 5,
    });
    const hardStop = stuck.find(s => s.reason === 'reject_hard_stop');
    expect(hardStop).toBeDefined();
  });

  it('held ticket does not appear as stuck', () => {
    board.createTicket({ title: 'Blocked', description: '', acceptance_criteria: ['Done'], dependencies: [], files: ['a.ts'], priority: 1 });
    board.transition('#1', 'in_progress');
    board.hold('#1', 'API rate limit');

    const stuck = detectStuckTickets(board.getTickets(), { stallThresholdMs: 0 });
    expect(stuck.find(s => s.ticket_id === '#1')).toBeUndefined();
  });

  it('release from held resumes to previous state', () => {
    board.createTicket({ title: 'Resumable', description: '', acceptance_criteria: ['Done'], dependencies: [], files: ['a.ts'], priority: 1 });
    board.transition('#1', 'in_progress');
    board.hold('#1', 'API down');
    board.release('#1');

    expect(board.getTicket('#1')!.status).toBe('in_progress');
    expect(board.getTicket('#1')!.held_reason).toBeNull();
  });

  it('test failure does not move ticket to review', () => {
    board.createTicket({ title: 'Testable', description: '', acceptance_criteria: ['Done'], dependencies: [], files: ['a.ts'], priority: 1 });
    board.transition('#1', 'in_progress');
    board.transition('#1', 'testing');

    board.setTestResults('#1', {
      passed: false, total: 1, passed_count: 0, failed_count: 1,
      failures: [{ test_name: 'should work', message: 'fail' }],
      coverage_delta: null, duration_ms: 100,
      test_branch: 'aelvyril/ticket-#1', timestamp: new Date().toISOString(),
    });

    board.transition('#1', 'in_progress');
    expect(board.getTicket('#1')!.status).toBe('in_progress');
    expect(board.getTicket('#1')!.test_results!.passed).toBe(false);
  });
});
