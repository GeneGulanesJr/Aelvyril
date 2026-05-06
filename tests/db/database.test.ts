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
});
