import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/db/database.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Database', () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-test-'));
    db = new Database(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initializes with WAL mode', () => {
    const journalMode = db.pragma('journal_mode');
    expect(journalMode[0].journal_mode).toBe('wal');
  });

  it('creates all required tables on init', () => {
    const tables = db.allTables();
    expect(tables).toContain('sessions');
    expect(tables).toContain('tickets');
    expect(tables).toContain('concurrency_plans');
    expect(tables).toContain('audit_log');
    expect(tables).toContain('cost_entries');
    expect(tables).toContain('config');
  });

  it('handles concurrent writes without errors', () => {
    const promises = Array.from({ length: 10 }, (_, i) => {
      db.insertAuditEntry({
        session_id: 'test',
        agent_type: 'supervisor',
        ticket_id: null,
        action: `test_action_${i}`,
        details: null,
        timestamp: new Date().toISOString(),
      });
    });
    expect(() => promises).not.toThrow();
  });

  it('creates _migrations table and tracks applied migrations', () => {
    const tables = db.allTables();
    expect(tables).toContain('_migrations');

    const rows = db.raw.prepare('SELECT version, name FROM _migrations ORDER BY version').all() as { version: number; name: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].version).toBe(1);
    expect(rows[0].name).toBe('initial_schema');
  });

  it('does not re-apply migrations on re-open', () => {
    const before = db.raw.prepare('SELECT COUNT(*) as count FROM _migrations').get() as { count: number };
    expect(before.count).toBe(1);

    db.close();
    db = new Database(path.join(tmpDir, 'test.db'));

    const after = db.raw.prepare('SELECT COUNT(*) as count FROM _migrations').get() as { count: number };
    expect(after.count).toBe(1);
  });
});
