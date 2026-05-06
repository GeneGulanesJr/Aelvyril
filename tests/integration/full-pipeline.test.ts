import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { Database } from '../../src/db/database.js';
import { BoardManager } from '../../src/board/board-manager.js';
import { SessionManager } from '../../src/sessions/session-manager.js';

describe('Full pipeline E2E', () => {
  let db: Database;
  let board: BoardManager;
  let tmpDir: string;
  let sessionId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-e2e-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    const sm = new SessionManager(db, path.join(tmpDir, 'workspaces'));

    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoDir);
    execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Project\n');
    execSync('git add . && git commit -m "init"', { cwd: repoDir, stdio: 'pipe' });

    const session = sm.create(repoDir);
    sessionId = session.id;
    board = new BoardManager(db, sessionId);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('happy path: create tickets → dispatch → test → review → done', () => {
    board.createTicket({
      title: 'Add theme context',
      description: 'Create theme context provider',
      acceptance_criteria: ['Context exports theme', 'Context supports light/dark'],
      dependencies: [],
      files: ['src/theme.tsx'],
      priority: 1,
    });
    board.createTicket({
      title: 'Build toggle',
      description: 'Build theme toggle component',
      acceptance_criteria: ['Toggle renders', 'Toggle switches theme'],
      dependencies: ['#1'],
      files: ['src/Toggle.tsx'],
      priority: 2,
    });

    board.saveConcurrencyPlan({
      max_parallel: 1,
      waves: [['#1'], ['#2']],
      conflict_groups: [],
    });

    board.transition('#1', 'in_progress');
    board.assignAgent('#1', 'sub-1');
    expect(board.getTicket('#1')!.status).toBe('in_progress');

    board.transition('#1', 'testing');
    board.setTestResults('#1', {
      passed: true, total: 5, passed_count: 5, failed_count: 0,
      failures: [], coverage_delta: null, duration_ms: 1500,
      test_branch: 'aelvyril/ticket-#1', timestamp: new Date().toISOString(),
    });
    board.transition('#1', 'in_review');
    board.transition('#1', 'done');
    expect(board.getTicket('#1')!.status).toBe('done');

    board.transition('#2', 'in_progress');
    board.transition('#2', 'testing');
    board.transition('#2', 'in_review');
    board.transition('#2', 'done');

    const doneTickets = board.getTicketsByStatus('done');
    expect(doneTickets).toHaveLength(2);
  });

  it('test failure path: sub-agent → test fail → back to in_progress', () => {
    board.createTicket({
      title: 'Add feature',
      description: 'Add feature X',
      acceptance_criteria: ['Feature works'],
      dependencies: [],
      files: ['src/feature.ts'],
      priority: 1,
    });

    board.transition('#1', 'in_progress');
    board.transition('#1', 'testing');

    board.setTestResults('#1', {
      passed: false, total: 3, passed_count: 2, failed_count: 1,
      failures: [{ test_name: 'should work', message: 'expected true received false' }],
      coverage_delta: null, duration_ms: 800,
      test_branch: 'aelvyril/ticket-#1', timestamp: new Date().toISOString(),
    });

    board.transition('#1', 'in_progress');
    expect(board.getTicket('#1')!.status).toBe('in_progress');
  });

  it('review rejection path: review reject → back to backlog', () => {
    board.createTicket({
      title: 'Add feature',
      description: 'Add feature X',
      acceptance_criteria: ['Feature works'],
      dependencies: [],
      files: ['src/feature.ts'],
      priority: 1,
    });

    board.transition('#1', 'in_progress');
    board.transition('#1', 'testing');
    board.transition('#1', 'in_review');

    board.reject('#1', 'Missing error handling for edge case');
    expect(board.getTicket('#1')!.status).toBe('backlog');
    expect(board.getTicket('#1')!.reject_count).toBe(1);
    expect(board.getTicket('#1')!.review_notes).toBe('Missing error handling for edge case');
  });

  it('held state path: API failure → held → release → resume', () => {
    board.createTicket({
      title: 'Add feature',
      description: 'Add feature X',
      acceptance_criteria: ['Feature works'],
      dependencies: [],
      files: ['src/feature.ts'],
      priority: 1,
    });

    board.transition('#1', 'in_progress');
    board.hold('#1', 'LLM API rate limit exceeded');
    expect(board.getTicket('#1')!.status).toBe('held');
    expect(board.getTicket('#1')!.held_reason).toBe('LLM API rate limit exceeded');

    board.release('#1');
    expect(board.getTicket('#1')!.status).toBe('in_progress');
    expect(board.getTicket('#1')!.held_reason).toBeNull();
  });

  it('cumulative cost tracking across retries', () => {
    board.createTicket({
      title: 'Add feature',
      description: 'Add feature X',
      acceptance_criteria: ['Feature works'],
      dependencies: [],
      files: ['src/feature.ts'],
      priority: 1,
    });

    board.addCost('#1', 1000, 0.05);
    board.reject('#1', 'Bad code');

    board.addCost('#1', 2000, 0.10);

    const ticket = board.getTicket('#1');
    expect(ticket!.cost_tokens).toBe(3000);
    expect(ticket!.cost_usd).toBeCloseTo(0.15);
  });
});
