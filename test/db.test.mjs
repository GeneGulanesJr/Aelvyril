import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openVault, reopen } from '../src/lib/db.mjs';

describe('openVault', () => {
  it('applies schema in memory', () => {
    const db = openVault(':memory:');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    for (const t of ['observations', 'observations_fts', 'observation_relations', 'staging_observations', 'vault_meta', 'vault_instances']) {
      expect(tables, `missing table ${t}`).toContain(t);
    }
    db.close();
  });

  it('is idempotent: open twice on the same path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aelvyril-'));
    const path = join(dir, 'vault.db');
    try {
      const db1 = openVault(path);
      db1.close();
      const db2 = reopen(path); // second open must not throw
      const tables = db2.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
      const obsCount = tables.filter(t => t === 'observations').length;
      expect(obsCount).toBe(1);
      expect(tables).toContain('staging_observations');
      expect(tables).toContain('vault_meta');
      expect(tables).toContain('vault_instances');
      // schema_version recorded once
      const sv = db2.prepare("SELECT value FROM vault_meta WHERE key='schema_version'").get();
      expect(sv.value).toBe('1');
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records schema_version on first open', () => {
    const db = openVault(':memory:');
    const sv = db.prepare("SELECT value FROM vault_meta WHERE key='schema_version'").get();
    expect(sv).toBeTruthy();
    expect(sv.value).toBe('1');
    db.close();
  });
});
