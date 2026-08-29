import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openVault } from '../src/lib/db.mjs';
import { mergeBatch, runPromote } from '../src/merge.mjs';
import { consolidateConflicts, glmConfigFromEnv } from '../src/glm-consolidate.mjs';

let db;
let reportsDir;

function row(overrides = {}) {
  return {
    id: 1, session_id: 's1', type: 'decision',
    title: 'Title A', content: 'Content A',
    project: 'lapis', scope: 'project', topic_key: 'cache',
    expires_at: null, created_at: '2026-08-28T10:00:00Z',
    updated_at: '2026-08-28T10:00:00Z', deleted_at: null,
    ...overrides,
  };
}

function seedConflict() {
  // Two instances, same topic_key, different titles → conflict
  mergeBatch(db, { instance: 'devbox', pushed_at: '', rows: [
    row({ id: 1, title: 'Use Redis for cache', content: 'redis content', updated_at: '2026-08-28T10:00:00Z' }),
  ]});
  mergeBatch(db, { instance: 'pc', pushed_at: '', rows: [
    row({ id: 1, title: 'Use Memcached for cache', content: 'memcached content', updated_at: '2026-08-29T10:00:00Z' }),
  ]});
  runPromote(db);
  return [{
    project: 'lapis',
    topic_key: 'cache',
    titles: [
      { title: 'Use Redis for cache', origin_instance: 'devbox', updated_at: '2026-08-28T10:00:00Z', canonical_id: 1 },
      { title: 'Use Memcached for cache', origin_instance: 'pc', updated_at: '2026-08-29T10:00:00Z', canonical_id: 2 },
    ],
  }];
}

beforeEach(() => {
  db = openVault(':memory:');
  reportsDir = mkdtempSync(join(tmpdir(), 'aelv-review-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('glmConfigFromEnv', () => {
  it('returns null when no GLM env vars set', () => {
    vi.stubEnv('GLM_API_KEY', '');
    vi.stubEnv('GLM_BASE_URL', '');
    expect(glmConfigFromEnv()).toBeNull();
  });

  it('reads config from env when set', () => {
    vi.stubEnv('GLM_BASE_URL', 'https://api.example.com/v1');
    vi.stubEnv('GLM_API_KEY', 'sk-test');
    vi.stubEnv('GLM_MODEL', 'glm-5.2');
    expect(glmConfigFromEnv()).toEqual({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'glm-5.2',
    });
  });
});

describe('consolidateConflicts', () => {
  it('merge action: updates newest canonical row and soft-deletes the other', async () => {
    const conflicts = seedConflict();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        action: 'merge',
        title: 'Cache layer: Redis (chosen)',
        content: 'Merged cache guidance.',
      }) } }],
    }), { status: 200 }));

    const result = await consolidateConflicts(db, conflicts, {
      baseUrl: 'https://api.example.com/v1', apiKey: 'test-key-12345', model: 'glm-5.2',
      fetch: fetchMock, reportsDir,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('glm-5.2');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toContain('Redis');

    // both source rows soft-deleted; one new merged row exists
    const alive = db.prepare('SELECT title, content FROM observations WHERE deleted_at IS NULL').all();
    expect(alive.length).toBe(1);
    expect(alive[0].title).toBe('Cache layer: Redis (chosen)');
    expect(alive[0].content).toBe('Merged cache guidance.');
    expect(result.merged).toBe(1);
    expect(result.flagged).toBe(0);
  });

  it('contradicts action: both rows left intact, review file written', async () => {
    const conflicts = seedConflict();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ action: 'contradicts' }) } }],
    }), { status: 200 }));

    const result = await consolidateConflicts(db, conflicts, {
      baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'glm-5.2',
      fetch: fetchMock, reportsDir,
    });

    expect(result.flagged).toBe(1);
    expect(result.merged).toBe(0);
    const alive = db.prepare('SELECT COUNT(*) AS n FROM observations WHERE deleted_at IS NULL').get().n;
    expect(alive).toBe(2);
    const files = readdirSync(reportsDir).filter((f) => f.startsWith('review-'));
    expect(files.length).toBe(1);
    const review = readFileSync(join(reportsDir, files[0]), 'utf8');
    expect(review).toContain('Use Redis for cache');
    expect(review).toContain('Use Memcached for cache');
  });

  it('no apiKey → graceful skip (throws typed error handled via opts, returns skipped)', async () => {
    const conflicts = seedConflict();
    const fetchMock = vi.fn();
    const result = await consolidateConflicts(db, conflicts, {
      reportsDir, fetch: fetchMock, onSkip: 'return',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.skipped).toBe(true);
    // canonical state untouched
    const alive = db.prepare('SELECT COUNT(*) AS n FROM observations WHERE deleted_at IS NULL').get().n;
    expect(alive).toBe(2);
  });

  it('throws typed GlmConfigError when no apiKey and no onSkip override', async () => {
    const conflicts = seedConflict();
    await expect(consolidateConflicts(db, conflicts, { reportsDir }))
      .rejects.toMatchObject({ name: 'GlmConfigError' });
  });
});
