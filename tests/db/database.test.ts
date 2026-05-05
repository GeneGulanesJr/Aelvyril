// tests/db/database.test.ts
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
    expect(() => {
      for (let i = 0; i < 10; i++) {
        db.insertAuditEntry({
          session_id: 'test',
          agent_type: 'supervisor',
          ticket_id: null,
          action: `test_action_${i}`,
          details: null,
          timestamp: new Date().toISOString(),
        });
      }
    }).not.toThrow();
  });

  it('inserts and reads audit entries', () => {
    db.insertAuditEntry({
      session_id: 'ses_abc',
      agent_type: 'supervisor',
      ticket_id: '#1',
      action: 'dispatched',
      details: 'Dispatched sub-agent',
      timestamp: '2026-01-01T00:00:00Z',
    });
    const entries = db.getAuditLog('ses_abc');
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('dispatched');
    expect(entries[0].ticket_id).toBe('#1');
  });

  it('inserts and reads config values', () => {
    db.setConfig('port', '3456');
    expect(db.getConfig('port')).toBe('3456');
    expect(db.getConfig('missing')).toBeNull();
  });

  it('overwrites config on setConfig', () => {
    db.setConfig('key', 'value1');
    db.setConfig('key', 'value2');
    expect(db.getConfig('key')).toBe('value2');
  });
});
