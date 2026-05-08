import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ValidationContractManager } from '../../src/missions/validation-contract.js';
import { SharedState } from '../../src/missions/shared-state.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { FeaturesFile, ModelAssignment, ValidationContract } from '../../src/missions/missions.types.js';

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

function makeContract(milestoneIndex = 0, milestoneName = 'M1'): ValidationContract {
  return {
    milestone_index: milestoneIndex,
    milestone_name: milestoneName,
    features: [
      {
        feature_id: '#1',
        feature_title: 'F1',
        unit_test_assertions: ['should pass'],
        integration_test_assertions: ['should integrate'],
        type_check_requirements: ['types match'],
      },
    ],
    functional_flows: [{ name: 'main flow', steps: ['step 1', 'step 2'] }],
    created_at: new Date().toISOString(),
    locked: false,
  };
}

describe('ValidationContractManager', () => {
  let tmpDir: string;
  let sharedState: SharedState;
  let manager: ValidationContractManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-vc-'));
    sharedState = new SharedState(tmpDir);
    sharedState.initialize(makeFeatures(), defaultModels);
    manager = new ValidationContractManager(sharedState);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('write() persists a ValidationContract to shared state', () => {
    const contract = makeContract();
    manager.write(contract);

    const filePath = path.join(tmpDir, 'validation-contract.md');
    expect(fs.existsSync(filePath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(raw.milestone_index).toBe(0);
    expect(raw.milestone_name).toBe('M1');
  });

  it('read() returns the written contract with correct shape', () => {
    const contract = makeContract();
    manager.write(contract);

    const result = manager.read();
    expect(result).not.toBeNull();
    expect(result!.milestone_index).toBe(0);
    expect(result!.milestone_name).toBe('M1');
    expect(result!.locked).toBe(false);
    expect(result!.features).toHaveLength(1);
    expect(result!.features[0].feature_id).toBe('#1');
    expect(result!.features[0].feature_title).toBe('F1');
    expect(result!.features[0].unit_test_assertions).toEqual(['should pass']);
    expect(result!.features[0].integration_test_assertions).toEqual(['should integrate']);
    expect(result!.features[0].type_check_requirements).toEqual(['types match']);
    expect(result!.functional_flows).toHaveLength(1);
    expect(result!.functional_flows[0].name).toBe('main flow');
    expect(result!.functional_flows[0].steps).toEqual(['step 1', 'step 2']);
    expect(typeof result!.created_at).toBe('string');
  });

  it('lock() sets locked to true and persists', () => {
    const contract = makeContract();
    manager.write(contract);

    manager.lock();

    const result = manager.read();
    expect(result).not.toBeNull();
    expect(result!.locked).toBe(true);
  });

  it('isLocked() reflects lock state', () => {
    expect(manager.isLocked()).toBe(false);

    const contract = makeContract();
    manager.write(contract);
    expect(manager.isLocked()).toBe(false);

    manager.lock();
    expect(manager.isLocked()).toBe(true);
  });

  it('writing to a locked contract throws', () => {
    const contract = makeContract();
    manager.write(contract);
    manager.lock();

    expect(() => manager.write(makeContract())).toThrow('locked');
  });

  it('writing a new contract after advanceMilestone() clears the old one', () => {
    const contract = makeContract(0, 'M1');
    manager.write(contract);
    expect(manager.read()).not.toBeNull();

    sharedState.advanceMilestone();
    expect(manager.read()).toBeNull();

    const newContract = makeContract(1, 'M2');
    manager.write(newContract);

    const result = manager.read();
    expect(result).not.toBeNull();
    expect(result!.milestone_index).toBe(1);
    expect(result!.milestone_name).toBe('M2');
  });
});
