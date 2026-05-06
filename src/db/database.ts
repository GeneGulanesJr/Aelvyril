import BetterSqlite3 from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { AuditEntry, CostEntry } from '../types/common.js';
import { migrations } from './migrations.js';

export class Database {
  private db: BetterSqlite3.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.runMigrations();
  }

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    const applied = new Set(
      (this.db.prepare('SELECT version FROM _migrations').all() as { version: number }[])
        .map(r => r.version)
    );

    for (const migration of migrations) {
      if (!applied.has(migration.version)) {
        this.db.exec(migration.up);
        const now = new Date().toISOString();
        this.db.prepare('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, now);
      }
    }
  }

  pragma(pragma: string): Record<string, string>[] {
    return this.db.pragma(pragma) as Record<string, string>[];
  }

  allTables(): string[] {
    const rows = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    return rows.map(r => r.name);
  }

  insertAuditEntry(entry: Omit<AuditEntry, never>): void {
    this.db.prepare(`
      INSERT INTO audit_log (session_id, agent_type, ticket_id, action, details, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      entry.session_id,
      entry.agent_type,
      entry.ticket_id,
      entry.action,
      entry.details,
      entry.timestamp
    );
  }

  getAuditLog(sessionId: string, limit = 100): AuditEntry[] {
    return this.db.prepare(`
      SELECT session_id, agent_type, ticket_id, action, details, timestamp
      FROM audit_log WHERE session_id = ?
      ORDER BY timestamp DESC LIMIT ?
    `).all(sessionId, limit) as AuditEntry[];
  }

  insertCostEntry(entry: Omit<CostEntry, never>): void {
    this.db.prepare(`
      INSERT INTO cost_entries (session_id, agent_type, ticket_id, model, input_tokens, output_tokens, cost_usd, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.session_id,
      entry.agent_type,
      entry.ticket_id,
      entry.model,
      entry.input_tokens,
      entry.output_tokens,
      entry.cost_usd,
      entry.timestamp
    );
  }

  getConfig(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setConfig(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
  }

  get raw(): BetterSqlite3.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
