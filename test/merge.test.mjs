import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openVault } from '../src/lib/db.mjs';
import { mergeBatch, runPromote, runMerge } from '../src/merge.mjs';

let db;

function row(overrides = {}) {
  return {
    id: 1, session_id: 's1', type: 'decision',
    title: 'Use SQLite WAL', content: 'Enable WAL for concurrency.',
    project: 'lapis', scope: 'project', topic_key: 'sqlite-wal',
    expires_at: null, created_at: '2026-08-28T10:00:00Z',
    updated_at: '2026-08-28T10:00:00Z', deleted_at: null,
    ...overrides,
  };
}

function batch(instance, rows, superseded_ids = []) {
  return { instance, pushed_at: new Date().toISOString(), rows, superseded_ids };
}

beforeEach(() => {
  db = openVault(':memory:');
});

describe('mergeBatch', () => {
  it('upserts rows into staging keyed by (origin_instance, source_id)', () => {
    mergeBatch(db, batch('devbox', [row({ id: 1 }), row({ id: 2 })]));
    const count = db.prepare('SELECT COUNT(*) AS n FROM staging_observations').get().n;
    expect(count).toBe(2);
    // re-ingest same rows → still 2 (upsert, no dupes)
    mergeBatch(db, batch('devbox', [row({ id: 1, content: 'changed' })]));
    const after = db.prepare("SELECT content FROM staging_observations WHERE source_id = 1 AND origin_instance = 'devbox'").get();
    expect(after.content).toBe('changed');
  });

  it('stores superseded pairs in staging_relations', () => {
    mergeBatch(db, batch('devbox', [row({ id: 1 }), row({ id: 2 })], [
      { source_id: 2, relation: 'supersedes', newer_source_id: 2 },
    ]));
    // contract: {source_id, relation, newer_source_id} — superseded row is source_id's target
    // normalize: store (superseded_id, kept_id, relation, origin_instance)
    const rel = db.prepare('SELECT * FROM staging_relations').all();
    expect(rel.length).toBe(1);
    expect(rel[0].origin_instance).toBe('devbox');
  });
});

describe('runPromote', () => {
  it('promotes staging rows into canonical observations with fresh ids', () => {
    mergeBatch(db, batch('devbox', [row({ id: 42 })]));
    runPromote(db);
    const canon = db.prepare("SELECT * FROM observations WHERE title = 'Use SQLite WAL'").all();
    expect(canon.length).toBe(1);
    // mapping recorded in staging
    const map = db.prepare('SELECT canonical_id FROM staging_observations WHERE source_id = 42').get();
    expect(map.canonical_id).toBe(canon[0].id);
  });

  it('merges exact duplicate (project, topic_key, title) from two instances into one canonical row', () => {
    mergeBatch(db, batch('devbox', [row({ id: 1 })]));
    mergeBatch(db, batch('pc', [row({ id: 1, content: 'Same lesson from PC.' })]));
    runPromote(db);
    const canon = db.prepare('SELECT COUNT(*) AS n FROM observations').get().n;
    expect(canon).toBe(1);
    // origin instances recorded on staging (2 distinct origins, same natural key)
    const origins = db.prepare("SELECT COUNT(DISTINCT origin_instance) AS n FROM staging_observations").get().n;
    expect(origins).toBe(2);
  });

  it('keeps newest updated_at on duplicate merge', () => {
    mergeBatch(db, batch('devbox', [row({ id: 1, updated_at: '2026-08-28T10:00:00Z', content: 'old' })]));
    mergeBatch(db, batch('pc', [row({ id: 1, updated_at: '2026-08-29T10:00:00Z', content: 'new content' })]));
    runPromote(db);
    const canon = db.prepare('SELECT content FROM observations').get();
    expect(canon.content).toBe('new content');
  });

  it('applies superseded relations by soft-deleting canonical rows', () => {
    // devbox row 7 superseded by row 8
    mergeBatch(db, batch('devbox', [
      row({ id: 7, title: 'Old approach', topic_key: 'cache' }),
      row({ id: 8, title: 'New approach', topic_key: 'cache' }),
    ], [{ source_id: 7, relation: 'supersedes', newer_source_id: 8 }]));
    runPromote(db);
    const old = db.prepare("SELECT deleted_at FROM observations WHERE title = 'Old approach'").get();
    const kept = db.prepare("SELECT deleted_at FROM observations WHERE title = 'New approach'").get();
    expect(old.deleted_at).not.toBeNull();
    expect(kept.deleted_at).toBeNull();
  });

  it('is idempotent: re-promoting same staging does not duplicate canonical rows', () => {
    mergeBatch(db, batch('devbox', [row({ id: 1 }), row({ id: 2, title: 'Second lesson' })]));
    runPromote(db);
    const first = db.prepare('SELECT COUNT(*) AS n FROM observations').get().n;
    runPromote(db);
    const again = db.prepare('SELECT COUNT(*) AS n FROM observations').get().n;
    expect(again).toBe(first);
  });

  it('rebuilds FTS so canonical rows are searchable', () => {
    mergeBatch(db, batch('devbox', [row({ id: 1, title: 'Enable WAL mode', content: 'wal journal' })]));
    runPromote(db);
    const hits = db.prepare("SELECT COUNT(*) AS n FROM observations_fts WHERE observations_fts MATCH 'wal'").get().n;
    expect(hits).toBe(1);
  });

  it('bumps vault_instances.last_merge_at', () => {
    mergeBatch(db, batch('devbox', [row({ id: 1 })]));
    runPromote(db);
    const inst = db.prepare("SELECT last_merge_at FROM vault_instances WHERE name = 'devbox'").get();
    expect(inst.last_merge_at).not.toBeNull();
  });
});

describe('runMerge', () => {
  let inboxDir;

  beforeEach(() => {
    inboxDir = mkdtempSync(join(tmpdir(), 'aelv-inbox-'));
  });

  it('processes inbox files oldest-first and archives them to processed/', () => {
    const instDir = join(inboxDir, 'devbox');
    mkdirSync(instDir);
    // write older file first
    writeFileSync(join(instDir, '2026-08-28T10-00-00.json'),
      JSON.stringify(batch('devbox', [row({ id: 1, title: 'First batch lesson' })])));
    writeFileSync(join(instDir, '2026-08-29T10-00-00.json'),
      JSON.stringify(batch('devbox', [row({ id: 2, title: 'Second batch lesson', updated_at: '2026-08-29T10:00:00Z' })])));

    const result = runMerge(db, inboxDir);
    expect(result.processed).toBe(2);
    const canon = db.prepare("SELECT COUNT(*) AS n FROM observations WHERE title LIKE '%batch lesson'").get().n;
    expect(canon).toBe(2);
    const processed = readdirSync(join(instDir, 'processed'));
    expect(processed.length).toBe(2);
    expect(readdirSync(instDir).filter((f) => f.endsWith('.json')).length).toBe(0);
  });

  it('detects cross-instance title conflicts on same (project, topic_key) and writes report', () => {
    const opts = { reportsDir: mkdtempSync(join(tmpdir(), 'aelv-reports-')) };
    const instA = join(inboxDir, 'devbox');
    const instB = join(inboxDir, 'pc');
    mkdirSync(instA); mkdirSync(instB);
    writeFileSync(join(instA, 'a.json'), JSON.stringify(batch('devbox', [
      row({ id: 1, title: 'Use Redis for cache', topic_key: 'cache-layer' }),
    ])));
    writeFileSync(join(instB, 'b.json'), JSON.stringify(batch('pc', [
      row({ id: 1, title: 'Use Memcached for cache', topic_key: 'cache-layer' }),
    ])));

    const result = runMerge(db, inboxDir, opts);
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].project).toBe('lapis');
    expect(result.conflicts[0].topic_key).toBe('cache-layer');
    // both canonical rows kept
    const n = db.prepare("SELECT COUNT(*) AS n FROM observations WHERE topic_key = 'cache-layer'").get().n;
    expect(n).toBe(2);
    const files = readdirSync(opts.reportsDir);
    expect(files.some((f) => f.startsWith('conflicts-') && f.endsWith('.md'))).toBe(true);
    const report = readFileSync(join(opts.reportsDir, files[0]), 'utf8');
    expect(report).toContain('Use Redis for cache');
    expect(report).toContain('Use Memcached for cache');
  });
});
