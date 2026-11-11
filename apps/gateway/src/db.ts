import Database from "better-sqlite3";
import { join } from "node:path";
import type { Config } from "./config.ts";

export type Db = Database.Database;

export function openDb(cfg: Config): Db {
  const db = new Database(join(cfg.dataDir, "aelvyril.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      session_file TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      thread_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (thread_id, seq)
    );
    CREATE INDEX IF NOT EXISTS events_by_type ON events (thread_id, type, seq);
  `);
  // Stream model: one permanent 'main' conversation, background 'job' threads, and legacy plain 'chat' threads.
  const have = new Set((db.prepare("PRAGMA table_info(threads)").all() as { name: string }[]).map((c) => c.name));
  for (const [col, ddl] of [
    ["kind", "TEXT NOT NULL DEFAULT 'chat'"],
    ["parent_id", "TEXT"],
    ["state", "TEXT"],
    ["preview", "TEXT NOT NULL DEFAULT ''"],
    ["resumes", "INTEGER NOT NULL DEFAULT 0"],
  ] as const) {
    if (!have.has(col)) db.exec(`ALTER TABLE threads ADD COLUMN ${col} ${ddl}`);
  }
  return db;
}
