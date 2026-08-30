import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

describe('nightly CLI end-to-end', () => {
  it('inbox batches → merge → digests written; GLM unset → pass B skipped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aelv-cli-'));
    const dbPath = join(root, 'vault.db');
    const inbox = join(root, 'inbox');
    const out = join(root, 'digests');
    const reports = join(root, 'reports');
    const instDir = join(inbox, 'devbox');
    mkdirSync(instDir, { recursive: true });
    writeFileSync(join(instDir, 'b1.json'), JSON.stringify({
      instance: 'devbox', pushed_at: new Date().toISOString(),
      rows: [{
        id: 1, session_id: 's', type: 'decision', title: 'Use WAL',
        content: 'Enable WAL.', project: 'lapis', scope: 'project',
        topic_key: 'sqlite', expires_at: null,
        created_at: '2026-08-28T10:00:00Z', updated_at: '2026-08-28T10:00:00Z',
        deleted_at: null,
      }],
      superseded_ids: [],
    }));

    const env = { ...process.env };
    delete env.GLM_API_KEY;
    delete env.GLM_BASE_URL;
    delete env.GLM_MODEL;

    const { stdout } = await run(process.execPath, ['src/nightly.mjs',
      '--db', dbPath, '--inbox', inbox, '--digests', out, '--reports', reports,
    ], { cwd: join(import.meta.dirname, '..'), env });

    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(join(out, 'lapis.md'))).toBe(true);
    expect(readFileSync(join(out, 'lapis.md'), 'utf8')).toContain('Use WAL');
    expect(existsSync(join(inbox, 'devbox', 'processed', 'b1.json'))).toBe(true);
    expect(stdout).toContain('skipped');
    expect(stdout).toContain('digests: lapis.md');
  });
});
