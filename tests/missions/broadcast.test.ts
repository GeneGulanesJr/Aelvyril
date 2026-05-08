import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SharedState } from '../../src/missions/shared-state.js';
import { BroadcastManager } from '../../src/missions/broadcast.js';
import type { FeaturesFile, ModelAssignment } from '../../src/missions/missions.types.js';

function makeFeatures(): FeaturesFile {
  return {
    mission_name: 'test-mission',
    goal: 'Test goal',
    milestones: [
      { index: 0, name: 'M1', features: ['#1'], status: 'pending', retry_count: 0 },
    ],
    features: [
      { id: '#1', title: 'F1', description: 'Feature 1', acceptance_criteria: ['a'], files: ['f1.ts'], status: 'pending', assigned_worker: null },
    ],
    current_milestone_index: 0,
  };
}

const defaultModels: ModelAssignment = {
  orchestrator: 'claude-sonnet-4-20250514',
  worker: 'gpt-4o',
  scrutiny_validator: 'claude-sonnet-4-20250514',
  user_testing_validator: 'claude-sonnet-4-20250514',
  research_subagent: 'gpt-4o-mini',
};

describe('BroadcastManager', () => {
  let tmpDir: string;
  let sharedState: SharedState;
  let broadcast: BroadcastManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-broadcast-'));
    sharedState = new SharedState(tmpDir);
    sharedState.initialize(makeFeatures(), defaultModels);
    broadcast = new BroadcastManager(sharedState);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('publish() appends a broadcast entry with correct from, type, message, and auto-generated timestamp', () => {
    const before = new Date().toISOString();
    broadcast.publish('orchestrator', 'status', 'mission started');
    const after = new Date().toISOString();

    const entries = broadcast.readAll();
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.from).toBe('orchestrator');
    expect(entry.type).toBe('status');
    expect(entry.message).toBe('mission started');
    expect(entry.timestamp >= before).toBe(true);
    expect(entry.timestamp <= after).toBe(true);
  });

  it('publish() works with constraint type', () => {
    broadcast.publish('worker', 'constraint', 'must use React');
    const entries = broadcast.readAll();
    expect(entries[0].type).toBe('constraint');
    expect(entries[0].from).toBe('worker');
    expect(entries[0].message).toBe('must use React');
  });

  it('publish() works with context type', () => {
    broadcast.publish('orchestrator', 'context', 'project uses TypeScript');
    const entries = broadcast.readAll();
    expect(entries[0].type).toBe('context');
  });

  it('readAll() returns all entries', () => {
    broadcast.publish('agent-a', 'status', 'msg1');
    broadcast.publish('agent-b', 'constraint', 'msg2');
    broadcast.publish('agent-c', 'context', 'msg3');

    const entries = broadcast.readAll();
    expect(entries).toHaveLength(3);
    expect(entries[0].from).toBe('agent-a');
    expect(entries[1].from).toBe('agent-b');
    expect(entries[2].from).toBe('agent-c');
  });

  it('readAll() returns empty array when no broadcasts', () => {
    const entries = broadcast.readAll();
    expect(entries).toEqual([]);
  });

  it('readSince(0) returns all entries', () => {
    broadcast.publish('a', 'status', 'first');
    broadcast.publish('b', 'constraint', 'second');
    broadcast.publish('c', 'context', 'third');

    const entries = broadcast.readSince(0);
    expect(entries).toHaveLength(3);
    expect(entries[0].from).toBe('a');
    expect(entries[2].from).toBe('c');
  });

  it('readSince(n) returns only entries after index n', () => {
    broadcast.publish('a', 'status', 'first');
    broadcast.publish('b', 'constraint', 'second');
    broadcast.publish('c', 'context', 'third');
    broadcast.publish('d', 'status', 'fourth');

    const since1 = broadcast.readSince(1);
    expect(since1).toHaveLength(3);
    expect(since1[0].from).toBe('b');
    expect(since1[2].from).toBe('d');

    const since2 = broadcast.readSince(2);
    expect(since2).toHaveLength(2);
    expect(since2[0].from).toBe('c');
    expect(since2[1].from).toBe('d');

    const since3 = broadcast.readSince(3);
    expect(since3).toHaveLength(1);
    expect(since3[0].from).toBe('d');
  });

  it('readSince() beyond last index returns empty array', () => {
    broadcast.publish('a', 'status', 'only');

    const entries = broadcast.readSince(5);
    expect(entries).toEqual([]);
  });

  it('multiple sequential publish() calls all appear in readAll()', () => {
    const messages = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    for (const msg of messages) {
      broadcast.publish('agent', 'status', msg);
    }

    const entries = broadcast.readAll();
    expect(entries).toHaveLength(5);
    expect(entries.map(e => e.message)).toEqual(messages);
  });

  it('entries preserve insertion order', () => {
    broadcast.publish('first', 'status', 'msg1');
    broadcast.publish('second', 'constraint', 'msg2');
    broadcast.publish('third', 'context', 'msg3');

    const entries = broadcast.readAll();
    const types = entries.map(e => e.type);
    expect(types).toEqual(['status', 'constraint', 'context']);
  });
});
