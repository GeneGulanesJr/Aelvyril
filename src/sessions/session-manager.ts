import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import type { Database } from '../db/database.js';
import type { Session } from '../types/common.js';

function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    if (parsed.username) {
      parsed.username = '***';
    }
    return parsed.toString();
  } catch {
    return url.replace(/\/\/[^@]+@/, '//***@');
  }
}

export class SessionManager {
  constructor(
    private db: Database,
    private baseDir: string
  ) {}

  create(repoUrl: string): Session {
    const id = `ses_${crypto.randomBytes(8).toString('hex')}`;
    const branch = `aelvyril/session-${id}`;
    const repoPath = path.join(this.baseDir, 'workspaces', id);
    const memoryDbPath = path.join(this.baseDir, 'memory', `${id}.db`);

    fs.mkdirSync(repoPath, { recursive: true });
    fs.mkdirSync(path.dirname(memoryDbPath), { recursive: true });

    const now = new Date().toISOString();
    this.db.raw.prepare(`
      INSERT INTO sessions (id, repo_url, repo_path, branch, status, memory_db_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(id, repoUrl, repoPath, branch, memoryDbPath, now, now);

    this.db.insertAuditEntry({
      session_id: id,
      agent_type: 'supervisor',
      ticket_id: null,
      action: 'session_created',
      details: `Created session for ${sanitizeUrl(repoUrl)}`,
      timestamp: now,
    });

    return this.get(id)!;
  }

  list(): Session[] {
    return this.db.raw.prepare(
      'SELECT * FROM sessions ORDER BY created_at DESC'
    ).all() as Session[];
  }

  get(id: string): Session | null {
    return this.db.raw.prepare(
      'SELECT * FROM sessions WHERE id = ?'
    ).get(id) as Session | null;
  }

  pause(id: string): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(
      "UPDATE sessions SET status = 'paused', updated_at = ? WHERE id = ?"
    ).run(now, id);
  }

  resume(id: string): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(
      "UPDATE sessions SET status = 'active', updated_at = ? WHERE id = ?"
    ).run(now, id);
  }

  markCrashed(id: string): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(
      "UPDATE sessions SET status = 'crashed', updated_at = ? WHERE id = ?"
    ).run(now, id);
  }

  complete(id: string): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(
      "UPDATE sessions SET status = 'completed', updated_at = ? WHERE id = ?"
    ).run(now, id);
  }

  findRecoverable(): Session[] {
    return this.db.raw.prepare(
      "SELECT * FROM sessions WHERE status IN ('active', 'crashed') ORDER BY created_at DESC"
    ).all() as Session[];
  }
}
