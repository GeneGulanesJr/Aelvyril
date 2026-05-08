import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HandoffLog } from '../../src/missions/handoff-log.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { HandoffEntry } from '../../src/missions/missions.types.js';

function makeEntry(overrides: Partial<HandoffEntry> = {}): HandoffEntry {
  return {
    timestamp: new Date().toISOString(),
    feature_id: '#1',
    milestone_index: 0,
    worker_id: 'worker-1',
    what_was_implemented: 'Feature A',
    what_remains: 'Nothing',
    errors_encountered: [],
    commands_run: [],
    exit_codes: {},
    git_commit_hash: 'abc123',
    ...overrides,
  };
}

describe('HandoffLog', () => {
  let tmpDir: string;
  let filePath: string;
  let log: HandoffLog;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-handoff-'));
    filePath = path.join(tmpDir, 'handoffs.jsonl');
    log = new HandoffLog(filePath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends one entry and reads it back', () => {
    const entry = makeEntry({ feature_id: '#1' });
    log.append(entry);
    const all = log.readAll();
    expect(all).toHaveLength(1);
    expect(all[0].feature_id).toBe('#1');
    expect(all[0].git_commit_hash).toBe('abc123');
  });

  it('appends multiple entries and reads all', () => {
    log.append(makeEntry({ feature_id: '#1' }));
    log.append(makeEntry({ feature_id: '#2' }));
    log.append(makeEntry({ feature_id: '#3' }));
    const all = log.readAll();
    expect(all).toHaveLength(3);
    expect(all.map(e => e.feature_id)).toEqual(['#1', '#2', '#3']);
  });

  it('readLatest returns the last entry', () => {
    log.append(makeEntry({ feature_id: '#1' }));
    log.append(makeEntry({ feature_id: '#2' }));
    const latest = log.readLatest();
    expect(latest).not.toBeNull();
    expect(latest!.feature_id).toBe('#2');
  });

  it('readLatestForFeature returns correct entry', () => {
    log.append(makeEntry({ feature_id: '#1', what_was_implemented: 'first' }));
    log.append(makeEntry({ feature_id: '#2', what_was_implemented: 'second' }));
    log.append(makeEntry({ feature_id: '#1', what_was_implemented: 'first-retry' }));
    const entry = log.readLatestForFeature('#1');
    expect(entry).not.toBeNull();
    expect(entry!.what_was_implemented).toBe('first-retry');
  });

  it('readForMilestone filters by milestone index', () => {
    log.append(makeEntry({ milestone_index: 0, feature_id: '#1' }));
    log.append(makeEntry({ milestone_index: 0, feature_id: '#2' }));
    log.append(makeEntry({ milestone_index: 1, feature_id: '#3' }));
    const m0 = log.readForMilestone(0);
    expect(m0).toHaveLength(2);
    const m1 = log.readForMilestone(1);
    expect(m1).toHaveLength(1);
  });

  it('count returns correct number', () => {
    expect(log.count()).toBe(0);
    log.append(makeEntry());
    expect(log.count()).toBe(1);
    log.append(makeEntry());
    expect(log.count()).toBe(2);
  });

  it('empty file returns empty array and null latest', () => {
    expect(log.readAll()).toEqual([]);
    expect(log.readLatest()).toBeNull();
    expect(log.count()).toBe(0);
  });

  it('corrupted line in middle does not break reads', () => {
    log.append(makeEntry({ feature_id: '#1' }));
    fs.appendFileSync(filePath, 'NOT JSON\n');
    log.append(makeEntry({ feature_id: '#3' }));
    const all = log.readAll();
    expect(all).toHaveLength(2);
    expect(all[0].feature_id).toBe('#1');
    expect(all[1].feature_id).toBe('#3');
  });

  it('readLatestForFeature returns null when feature not found', () => {
    log.append(makeEntry({ feature_id: '#1' }));
    expect(log.readLatestForFeature('#99')).toBeNull();
  });
});
