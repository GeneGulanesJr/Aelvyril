import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SharedState } from '../../src/missions/shared-state.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { FeaturesFile, ModelAssignment, BroadcastEntry, ErrorEntry, ValidationContract } from '../../src/missions/missions.types.js';

function makeFeatures(): FeaturesFile {
  return {
    mission_name: 'test-mission',
    goal: 'Test goal',
    milestones: [
      { index: 0, name: 'M1', features: ['#1', '#2'], status: 'pending', retry_count: 0 },
      { index: 1, name: 'M2', features: ['#3'], status: 'pending', retry_count: 0 },
    ],
    features: [
      { id: '#1', title: 'F1', description: 'Feature 1', acceptance_criteria: ['a'], files: ['f1.ts'], status: 'pending', assigned_worker: null },
      { id: '#2', title: 'F2', description: 'Feature 2', acceptance_criteria: ['b'], files: ['f2.ts'], status: 'pending', assigned_worker: null },
      { id: '#3', title: 'F3', description: 'Feature 3', acceptance_criteria: ['c'], files: ['f3.ts'], status: 'pending', assigned_worker: null },
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

describe('SharedState', () => {
  let tmpDir: string;
  let sharedState: SharedState;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-shared-'));
    sharedState = new SharedState(tmpDir);
    sharedState.initialize(makeFeatures(), defaultModels);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initializes directory structure', () => {
    expect(fs.existsSync(path.join(tmpDir, 'features.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'handoffs.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'model-assignment.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'broadcasts.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'error-log.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'command-log.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'research-findings'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'agent-skills'))).toBe(true);
  });

  it('reads features after initialize', () => {
    const features = sharedState.readFeatures();
    expect(features.mission_name).toBe('test-mission');
    expect(features.milestones).toHaveLength(2);
    expect(features.features).toHaveLength(3);
  });

  it('writes and reads features', () => {
    const features = sharedState.readFeatures();
    features.features[0].status = 'done';
    sharedState.writeFeatures(features);
    const read = sharedState.readFeatures();
    expect(read.features[0].status).toBe('done');
  });

  it('advances milestone', () => {
    sharedState.advanceMilestone();
    const features = sharedState.readFeatures();
    expect(features.current_milestone_index).toBe(1);
    expect(features.milestones[0].status).toBe('done');
  });

  it('updates feature status', () => {
    sharedState.updateFeatureStatus('#1', 'done');
    const features = sharedState.readFeatures();
    expect(features.features[0].status).toBe('done');
  });

  it('appends and reads handoffs', () => {
    sharedState.appendHandoff({
      timestamp: new Date().toISOString(),
      feature_id: '#1',
      milestone_index: 0,
      worker_id: 'w1',
      what_was_implemented: 'F1',
      what_remains: '',
      errors_encountered: [],
      commands_run: [],
      exit_codes: {},
      git_commit_hash: 'abc',
    });
    const handoffs = sharedState.readHandoffs();
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].feature_id).toBe('#1');
  });

  it('reads latest handoff', () => {
    sharedState.appendHandoff({
      timestamp: new Date().toISOString(), feature_id: '#1', milestone_index: 0,
      worker_id: 'w1', what_was_implemented: 'F1', what_remains: '',
      errors_encountered: [], commands_run: [], exit_codes: {}, git_commit_hash: 'abc',
    });
    sharedState.appendHandoff({
      timestamp: new Date().toISOString(), feature_id: '#2', milestone_index: 0,
      worker_id: 'w2', what_was_implemented: 'F2', what_remains: '',
      errors_encountered: [], commands_run: [], exit_codes: {}, git_commit_hash: 'def',
    });
    const latest = sharedState.readLatestHandoff();
    expect(latest).not.toBeNull();
    expect(latest!.feature_id).toBe('#2');
  });

  it('writes and reads validation contract', () => {
    const contract: ValidationContract = {
      milestone_index: 0,
      milestone_name: 'M1',
      features: [{
        feature_id: '#1', feature_title: 'F1',
        unit_test_assertions: ['should work'],
        integration_test_assertions: [],
        type_check_requirements: [],
      }],
      functional_flows: [],
      created_at: new Date().toISOString(),
      locked: false,
    };
    sharedState.writeValidationContract(contract);
    const read = sharedState.readValidationContract();
    expect(read).not.toBeNull();
    expect(read!.milestone_name).toBe('M1');
  });

  it('rejects writing locked validation contract', () => {
    const contract: ValidationContract = {
      milestone_index: 0, milestone_name: 'M1',
      features: [], functional_flows: [],
      created_at: new Date().toISOString(), locked: false,
    };
    sharedState.writeValidationContract(contract);
    sharedState.lockValidationContract();
    expect(() => sharedState.writeValidationContract({ ...contract })).toThrow('locked');
  });

  it('reads model assignment', () => {
    const models = sharedState.readModelAssignment();
    expect(models.worker).toBe('gpt-4o');
  });

  it('appends and reads broadcasts', () => {
    sharedState.appendBroadcast({ timestamp: new Date().toISOString(), from: 'orchestrator', type: 'status', message: 'started' });
    sharedState.appendBroadcast({ timestamp: new Date().toISOString(), from: 'worker', type: 'context', message: 'progress' });
    const all = sharedState.readBroadcasts();
    expect(all).toHaveLength(2);
    const since1 = sharedState.readBroadcasts(1);
    expect(since1).toHaveLength(1);
    expect(since1[0].from).toBe('worker');
  });

  it('appends and reads errors', () => {
    sharedState.appendError({ timestamp: new Date().toISOString(), agent: 'worker', feature_id: '#1', error: 'crash', recoverable: true });
    const errors = sharedState.readErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBe('crash');
  });

  it('writes and reads research findings', () => {
    sharedState.writeResearchFinding('f1', '# Finding 1\nDetails here');
    sharedState.writeResearchFinding('f2', '# Finding 2\nMore details');
    const findings = sharedState.readResearchFindings();
    expect(findings.size).toBe(2);
    expect(findings.get('f1')).toContain('Finding 1');
  });

  it('worker lock prevents double acquire', () => {
    sharedState.acquireWorkerLock('w1', '#1');
    expect(() => sharedState.acquireWorkerLock('w2', '#2')).toThrow();
    sharedState.releaseWorkerLock();
    expect(() => sharedState.acquireWorkerLock('w2', '#2')).not.toThrow();
  });

  it('reads worker lock', () => {
    expect(sharedState.readWorkerLock()).toBeNull();
    sharedState.acquireWorkerLock('w1', '#1');
    const lock = sharedState.readWorkerLock();
    expect(lock).not.toBeNull();
    expect(lock!.worker_id).toBe('w1');
  });
});
