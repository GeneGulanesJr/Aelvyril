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

  it('finds active sessions for crash recovery', () => {
    sm.create('https://github.com/user/repo1.git');
    const s2 = sm.create('https://github.com/user/repo2.git');
    sm.pause(s2.id);
    const active = sm.findRecoverable();
    expect(active).toHaveLength(1);
    expect(active[0].status).toBe('active');
  });
});
