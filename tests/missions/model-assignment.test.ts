import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ModelAssignmentManager, DEFAULT_MODEL_ASSIGNMENT } from '../../src/missions/model-assignment.js';
import { SharedState } from '../../src/missions/shared-state.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
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

const testModels: ModelAssignment = {
  orchestrator: 'claude-sonnet-4-20250514',
  worker: 'gpt-4o',
  scrutiny_validator: 'claude-sonnet-4-20250514',
  user_testing_validator: 'claude-sonnet-4-20250514',
  research_subagent: 'gpt-4o-mini',
};

describe('ModelAssignmentManager', () => {
  let tmpDir: string;
  let sharedState: SharedState;
  let manager: ModelAssignmentManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-model-assign-'));
    sharedState = new SharedState(tmpDir);
    sharedState.initialize(makeFeatures(), testModels);
    manager = new ModelAssignmentManager(sharedState);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('load() returns the initialized model assignment', () => {
    const result = manager.load();
    expect(result).toEqual(testModels);
  });

  it('update() merges partial config and persists', () => {
    manager.update({ worker: 'gpt-4o-mini', orchestrator: 'claude-haiku-3-20240307' });
    const result = manager.load();
    expect(result.worker).toBe('gpt-4o-mini');
    expect(result.orchestrator).toBe('claude-haiku-3-20240307');
    expect(result.scrutiny_validator).toBe(testModels.scrutiny_validator);
    expect(result.user_testing_validator).toBe(testModels.user_testing_validator);
    expect(result.research_subagent).toBe(testModels.research_subagent);
  });

  it('resolveForAgentType() returns correct model for orchestrator', () => {
    expect(manager.resolveForAgentType('orchestrator')).toBe('claude-sonnet-4-20250514');
  });

  it('resolveForAgentType() returns correct model for worker', () => {
    expect(manager.resolveForAgentType('worker')).toBe('gpt-4o');
  });

  it('resolveForAgentType() returns correct model for scrutiny_validator', () => {
    expect(manager.resolveForAgentType('scrutiny_validator')).toBe('claude-sonnet-4-20250514');
  });

  it('resolveForAgentType() returns correct model for user_testing_validator', () => {
    expect(manager.resolveForAgentType('user_testing_validator')).toBe('claude-sonnet-4-20250514');
  });

  it('resolveForAgentType() returns correct model for research_subagent', () => {
    expect(manager.resolveForAgentType('research_subagent')).toBe('gpt-4o-mini');
  });

  it('resolveForAgentType() throws for unknown agent type', () => {
    expect(() => manager.resolveForAgentType('nonexistent')).toThrow('Unknown agent type: nonexistent');
  });

  it('load() returns DEFAULT_MODEL_ASSIGNMENT when no stored data', () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-empty-'));
    try {
      const freshState = new SharedState(freshDir);
      fs.mkdirSync(freshDir, { recursive: true });
      const freshManager = new ModelAssignmentManager(freshState);
      const result = freshManager.load();
      expect(result).toEqual(DEFAULT_MODEL_ASSIGNMENT);
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });
});
