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
    // the project a task belongs to (its board on the Tasks screen); empty for the Stream and older chats
    ["board", "TEXT NOT NULL DEFAULT ''"],
    // the coding project (sandbox) a task works in; its file and shell tools run there
    ["project", "TEXT NOT NULL DEFAULT ''"],
    // what the Stream asked the task to do (it may have forgotten by the time the result comes back), and how often it sent the task back
    ["task", "TEXT NOT NULL DEFAULT ''"],
    ["sendbacks", "INTEGER NOT NULL DEFAULT 0"],
  ] as const) {
    if (!have.has(col)) db.exec(`ALTER TABLE threads ADD COLUMN ${col} ${ddl}`);
  }
  return db;
}
