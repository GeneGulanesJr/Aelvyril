// tests/audit/audit-log.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuditLog } from '../../src/audit/audit-log.js';
import { Database } from '../../src/db/database.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('AuditLog', () => {
  let audit: AuditLog;
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-audit-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    audit = new AuditLog(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('logs an action and retrieves it', () => {
    audit.log('ses_123', 'supervisor', null, 'session_created', 'Created session');
    const entries = audit.getRecent('ses_123');
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('session_created');
    expect(entries[0].agent_type).toBe('supervisor');
  });

  it('logs with ticket context', () => {
    audit.log('ses_123', 'main', '#1', 'dispatched', 'Sub-agent for ticket #1');
    const entries = audit.getRecent('ses_123');
    expect(entries[0].ticket_id).toBe('#1');
  });

  it('respects limit', () => {
    for (let i = 0; i < 20; i++) {
      audit.log('ses_123', 'supervisor', null, `action_${i}`, null);
    }
    const entries = audit.getRecent('ses_123', 5);
    expect(entries).toHaveLength(5);
  });

  it('orders by id descending (recency)', () => {
    audit.log('ses_123', 'supervisor', null, 'first', null);
    audit.log('ses_123', 'supervisor', null, 'second', null);
    const entries = audit.getRecent('ses_123');
    // SQLite AUTOINCREMENT id guarantees ordering even with same timestamp
    expect(entries[0].action).toBe('second');
    expect(entries[1].action).toBe('first');
  });
});
