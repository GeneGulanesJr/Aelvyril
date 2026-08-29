import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openVault } from '../src/lib/db.mjs';
import { writeDigests } from '../src/digest.mjs';

let db;
let outDir;

function insert(title, content, type, project, updated_at) {
  db.prepare(`
    INSERT INTO observations (session_id, type, title, content, project, scope, topic_key, created_at, updated_at)
    VALUES ('s1', ?, ?, ?, ?, 'project', 'tk', ?, ?)
  `).run(type, title, content, project, updated_at, updated_at);
}

beforeEach(() => {
  db = openVault(':memory:');
  outDir = mkdtempSync(join(tmpdir(), 'aelv-digest-'));
});

describe('writeDigests', () => {
  it('writes one markdown file per project, sections in type order, newest first', () => {
    insert('Old decision', 'd content', 'decision', 'lapis', '2026-08-27T10:00:00Z');
    insert('New decision', 'd content 2', 'decision', 'lapis', '2026-08-29T10:00:00Z');
    insert('A pattern', 'p content', 'pattern', 'lapis', '2026-08-28T10:00:00Z');
    insert('A bugfix', 'b content', 'bugfix', 'lapis', '2026-08-28T10:00:00Z');
    insert('A learning', 'l content', 'learning', 'lapis', '2026-08-28T10:00:00Z');
    insert('Other project item', 'o content', 'preference', 'gulaneskorp', '2026-08-28T10:00:00Z');

    const files = writeDigests(db, outDir);
    expect(files.sort()).toEqual(['gulaneskorp.md', 'lapis.md']);

    const md = readFileSync(join(outDir, 'lapis.md'), 'utf8');
    // section order: decision, architecture, bugfix, pattern, preference, learning
    const idxDecision = md.indexOf('## decision');
    const idxBugfix = md.indexOf('## bugfix');
    const idxPattern = md.indexOf('## pattern');
    const idxLearning = md.indexOf('## learning');
    expect(idxDecision).toBeGreaterThan(-1);
    expect(idxBugfix).toBeGreaterThan(idxDecision);
    expect(idxPattern).toBeGreaterThan(idxBugfix);
    expect(idxLearning).toBeGreaterThan(idxPattern);
    // no architecture section when empty
    expect(md).not.toContain('## architecture');

    // newest first within a section
    expect(md.indexOf('New decision')).toBeLessThan(md.indexOf('Old decision'));

    // item format
    expect(md).toContain('### [decision] New decision');

    // footer counts
    expect(md).toMatch(/5 item/);

    const other = readFileSync(join(outDir, 'gulaneskorp.md'), 'utf8');
    expect(other).toContain('Other project item');
    expect(other).toContain('## preference');
  });

  it('excludes soft-deleted rows', () => {
    insert('Visible', 'v', 'decision', 'p1', '2026-08-28T10:00:00Z');
    insert('Deleted', 'x', 'decision', 'p1', '2026-08-28T10:00:00Z');
    db.prepare("UPDATE observations SET deleted_at = '2026-08-29T00:00:00Z' WHERE title = 'Deleted'").run();
    const files = writeDigests(db, outDir);
    const md = readFileSync(join(outDir, 'p1.md'), 'utf8');
    expect(md).toContain('Visible');
    expect(md).not.toContain('Deleted');
  });

  it('footer contains per-type counts line', () => {
    insert('D1', 'c', 'decision', 'p1', '2026-08-28T10:00:00Z');
    insert('P1', 'c', 'pattern', 'p1', '2026-08-28T10:00:00Z');
    writeDigests(db, outDir);
    const md = readFileSync(join(outDir, 'p1.md'), 'utf8');
    expect(md).toMatch(/decision: 1/);
    expect(md).toMatch(/pattern: 1/);
  });
});
