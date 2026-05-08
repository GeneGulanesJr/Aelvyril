import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SharedState } from '../../src/missions/shared-state.js';
import { SkillLoader } from '../../src/missions/skill-loader.js';
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

describe('SkillLoader', () => {
  let tmpDir: string;
  let sharedState: SharedState;
  let loader: SkillLoader;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-skill-'));
    sharedState = new SharedState(tmpDir);
    sharedState.initialize(makeFeatures(), defaultModels);
    loader = new SkillLoader(sharedState);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads an existing skill file and returns its contents', () => {
    const content = loader.loadSkill('worker-implement');
    expect(content).toContain('# Worker Agent: Implement Feature');
  });

  it('substitutes {{key}} placeholders with vars', () => {
    const content = loader.loadSkill('worker-implement', {
      feature_id: 'FEAT-42',
      feature_title: 'My Cool Feature',
    });
    expect(content).toContain('FEAT-42');
    expect(content).toContain('My Cool Feature');
    expect(content).not.toContain('{{feature_id}}');
    expect(content).not.toContain('{{feature_title}}');
  });

  it('listSkills returns all .md filenames without extension from agent-skills', () => {
    const skills = loader.listSkills();
    expect(skills).toContain('worker-implement');
    expect(skills).toContain('worker-handoff');
    expect(skills).toContain('orchestrator-plan');
    expect(skills).toContain('orchestrator-negotiate');
    expect(skills).toContain('scrutiny-validator');
    expect(skills).toContain('user-testing-validator');
    expect(skills).toContain('research-subagent');
    for (const name of skills) {
      expect(name.endsWith('.md')).toBe(false);
    }
  });

  it('throws Skill not found for a nonexistent skill', () => {
    expect(() => loader.loadSkill('does-not-exist')).toThrow(
      'Skill not found: does-not-exist',
    );
  });

  it('returns raw content unchanged when no vars are provided', () => {
    const withVars = loader.loadSkill('worker-implement');
    const raw = fs.readFileSync(
      path.join(tmpDir, 'agent-skills', 'worker-implement.md'),
      'utf-8',
    );
    expect(withVars).toBe(raw);
  });
});
