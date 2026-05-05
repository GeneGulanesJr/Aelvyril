// tests/sessions/session-manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../../src/sessions/session-manager.js';
import { Database } from '../../src/db/database.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('SessionManager', () => {
  let db: Database;
  let sm: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-session-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    sm = new SessionManager(db, tmpDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a session with a generated ID and branch', () => {
    const session = sm.create('https://github.com/user/repo.git');
    expect(session.id).toMatch(/^ses_[a-z0-9]+$/);
    expect(session.repo_url).toBe('https://github.com/user/repo.git');
    expect(session.branch).toBe(`aelvyril/session-${session.id}`);
    expect(session.status).toBe('active');
    expect(session.memory_db_path).toContain(session.id);
  });

  it('lists all sessions', () => {
    sm.create('https://github.com/user/repo1.git');
    sm.create('https://github.com/user/repo2.git');
    const sessions = sm.list();
    expect(sessions).toHaveLength(2);
  });

  it('gets a session by ID', () => {
    const created = sm.create('https://github.com/user/repo.git');
    const found = sm.get(created.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
  });

  it('returns null for missing session', () => {
    expect(sm.get('nonexistent')).toBeNull();
  });

  it('pauses and resumes a session', () => {
    const session = sm.create('https://github.com/user/repo.git');
    sm.pause(session.id);
    expect(sm.get(session.id)!.status).toBe('paused');

    sm.resume(session.id);
    expect(sm.get(session.id)!.status).toBe('active');
  });

  it('marks a session as crashed', () => {
    const session = sm.create('https://github.com/user/repo.git');
    sm.markCrashed(session.id);
    expect(sm.get(session.id)!.status).toBe('crashed');
  });

  it('completes a session', () => {
    const session = sm.create('https://github.com/user/repo.git');
    sm.complete(session.id);
    expect(sm.get(session.id)!.status).toBe('completed');
  });

  it('finds recoverable sessions (active + crashed)', () => {
    sm.create('https://github.com/user/repo1.git');
    const s2 = sm.create('https://github.com/user/repo2.git');
    sm.pause(s2.id);
    const s3 = sm.create('https://github.com/user/repo3.git');
    sm.markCrashed(s3.id);
    const s4 = sm.create('https://github.com/user/repo4.git');
    sm.complete(s4.id);

    const recoverable = sm.findRecoverable();
    expect(recoverable).toHaveLength(2); // active + crashed
  });
});
