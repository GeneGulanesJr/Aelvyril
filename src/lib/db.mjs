import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../schema/vault-schema.sql');

/**
 * Open (and create if needed) an Aelvyril vault database, applying
 * schema/vault-schema.sql idempotently (all statements are IF NOT EXISTS)
 * and recording vault_meta.schema_version = '1' if absent.
 *
 * Backed by node:sqlite (DatabaseSync) — better-sqlite3 does not compile
 * on Node 26; node:sqlite is the stable built-in equivalent.
 *
 * @param {string} path file path or ':memory:'
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openVault(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  db.prepare("INSERT INTO vault_meta (key, value) SELECT 'schema_version', '1' WHERE NOT EXISTS (SELECT 1 FROM vault_meta WHERE key = 'schema_version')").run();
  return db;
}

/** Alias for tests / reopen semantics — opening the same path twice is safe. */
export const reopen = openVault;
