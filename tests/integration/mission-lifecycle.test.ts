import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Orchestrator } from '../../src/orchestrator.js';
import { SharedState } from '../../src/missions/shared-state.js';
import { SkillLoader } from '../../src/missions/skill-loader.js';
import type { FeaturesFile } from '../../src/missions/missions.types.js';

describe('Mission lifecycle', () => {
  let tmpDir: string;
  let db: Database;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-mission-'));
    orchestrator = new Orchestrator({
      port: 0,
      workspaceRoot: path.join(tmpDir, 'workspaces'),
      dbPath: path.join(tmpDir, 'test.db'),
    });
    db = orchestrator.db;
  });

  afterEach(() => {
    orchestrator.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('startMission initializes shared state, features, model assignment, and skills', () => {
    const result = orchestrator.startMission({
      goal: 'Add login page with OAuth',
      repoUrl: 'https://github.com/example/repo.git',
      context: 'Must support Google and GitHub OAuth',
    });

    expect(result.sessionId).toBeDefined();
    expect(result.sharedState).toBeInstanceOf(SharedState);

    const features = result.sharedState.readFeatures();
    expect(features.mission_name).toBe('Add login page with OAuth');
    expect(features.goal).toBe('Add login page with OAuth');
    expect(features.milestones).toHaveLength(1);
    expect(features.features).toHaveLength(1);
    expect(features.current_milestone_index).toBe(0);

    const models = result.sharedState.readModelAssignment();
    expect(models).toBeDefined();
    expect(models.orchestrator).toBeDefined();

    const skillLoader = new SkillLoader(result.sharedState);
    const skills = skillLoader.listSkills();
    expect(skills.length).toBeGreaterThanOrEqual(2);
    expect(skills).toContain('worker-implement');
    expect(skills).toContain('research-subagent');
  });

  it('getMissionState returns shared state after startMission', () => {
    const { sessionId } = orchestrator.startMission({
      goal: 'Build API',
      repoUrl: 'https://github.com/example/api.git',
    });

    const state = orchestrator.getMissionState(sessionId);
    expect(state).toBeDefined();
    expect(state!.readFeatures().goal).toBe('Build API');

    expect(orchestrator.getMissionState('nonexistent')).toBeUndefined();
  });

  it('shared state file structure is correct after initialization', () => {
    const { sharedState } = orchestrator.startMission({
      goal: 'Test file structure',
      repoUrl: 'https://github.com/example/test.git',
    });

    const missionDir = sharedState.getMissionDir();
    expect(fs.existsSync(path.join(missionDir, 'features.json'))).toBe(true);
    expect(fs.existsSync(path.join(missionDir, 'model-assignment.json'))).toBe(true);
    expect(fs.existsSync(path.join(missionDir, 'broadcasts.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(missionDir, 'error-log.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(missionDir, 'command-log.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(missionDir, 'agent-skills'))).toBe(true);
    expect(fs.existsSync(path.join(missionDir, 'research-findings'))).toBe(true);
  });

  it('shared state supports feature status updates', () => {
    const { sharedState } = orchestrator.startMission({
      goal: 'Test status updates',
      repoUrl: 'https://github.com/example/test.git',
    });

    const features = sharedState.readFeatures();
    const featureId = features.features[0].id;

    sharedState.updateFeatureStatus(featureId, 'in_progress');
    expect(sharedState.readFeatures().features[0].status).toBe('in_progress');

    sharedState.updateFeatureStatus(featureId, 'done');
    expect(sharedState.readFeatures().features[0].status).toBe('done');
  });

  it('shared state supports milestone advancement', () => {
    const { sharedState } = orchestrator.startMission({
      goal: 'Test milestone advance',
      repoUrl: 'https://github.com/example/test.git',
    });

    const features = sharedState.readFeatures();
    features.milestones.push({
      index: 1,
      name: 'Phase 2',
      features: [],
      status: 'pending',
      retry_count: 0,
    });
    sharedState.writeFeatures(features);

    sharedState.advanceMilestone();
    const updated = sharedState.readFeatures();
    expect(updated.milestones[0].status).toBe('done');
    expect(updated.current_milestone_index).toBe(1);
    expect(updated.milestones[1].status).toBe('in_progress');
  });

  it('handoff log records worker completions', () => {
    const { sharedState } = orchestrator.startMission({
      goal: 'Test handoff',
      repoUrl: 'https://github.com/example/test.git',
    });

    expect(sharedState.readHandoffs()).toHaveLength(0);

    sharedState.appendHandoff({
      timestamp: new Date().toISOString(),
      feature_id: '#1',
      milestone_index: 0,
      worker_id: 'worker-test-1',
      what_was_implemented: 'Feature #1',
      what_remains: '',
      errors_encountered: [],
      commands_run: ['npm test'],
      exit_codes: { 'npm test': 0 },
      git_commit_hash: 'abc123',
    });

    const handoffs = sharedState.readHandoffs();
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].worker_id).toBe('worker-test-1');
    expect(handoffs[0].git_commit_hash).toBe('abc123');

    const latest = sharedState.readLatestHandoff();
    expect(latest).toBeDefined();
    expect(latest!.feature_id).toBe('#1');
  });

  it('worker lock enforces serial constraint', () => {
    const { sharedState } = orchestrator.startMission({
      goal: 'Test lock',
      repoUrl: 'https://github.com/example/test.git',
    });

    sharedState.acquireWorkerLock('worker-1', '#1');
    const lock = sharedState.readWorkerLock();
    expect(lock).toBeDefined();
    expect(lock!.worker_id).toBe('worker-1');

    expect(() => sharedState.acquireWorkerLock('worker-2', '#2')).toThrow(/Worker slot occupied/);

    sharedState.releaseWorkerLock();
    expect(sharedState.readWorkerLock()).toBeNull();

    sharedState.acquireWorkerLock('worker-2', '#2');
    expect(sharedState.readWorkerLock()!.worker_id).toBe('worker-2');
    sharedState.releaseWorkerLock();
  });

  it('validation contract can be written and locked', () => {
    const { sharedState } = orchestrator.startMission({
      goal: 'Test validation',
      repoUrl: 'https://github.com/example/test.git',
    });

    const contract = {
      milestone_index: 0,
      milestone_name: 'Implementation',
      features: [{
        feature_id: '#1',
        feature_title: 'Test feature',
        unit_test_assertions: ['should pass'],
        integration_test_assertions: [],
        type_check_requirements: [],
      }],
      functional_flows: [],
      created_at: new Date().toISOString(),
      locked: false,
    };

    sharedState.writeValidationContract(contract);
    const read = sharedState.readValidationContract();
    expect(read).toBeDefined();
    expect(read!.locked).toBe(false);

    sharedState.lockValidationContract();
    const locked = sharedState.readValidationContract();
    expect(locked!.locked).toBe(true);

    expect(() => sharedState.writeValidationContract(contract)).toThrow(/locked/);
  });

  it('broadcast manager publishes events', () => {
    const { sharedState } = orchestrator.startMission({
      goal: 'Test broadcast',
      repoUrl: 'https://github.com/example/test.git',
    });

    sharedState.appendBroadcast({
      source: 'orchestrator',
      type: 'status',
      message: 'Mission started',
      timestamp: new Date().toISOString(),
    });

    const broadcasts = sharedState.readBroadcasts();
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].message).toBe('Mission started');

    sharedState.appendBroadcast({
      source: 'worker',
      type: 'progress',
      message: 'Feature done',
      timestamp: new Date().toISOString(),
    });

    const since = sharedState.readBroadcasts(1);
    expect(since).toHaveLength(1);
    expect(since[0].source).toBe('worker');
  });

  it('error log records and reads errors', () => {
    const { sharedState } = orchestrator.startMission({
      goal: 'Test errors',
      repoUrl: 'https://github.com/example/test.git',
    });

    sharedState.appendError({
      timestamp: new Date().toISOString(),
      agent: 'worker',
      feature_id: '#1',
      error: 'Something went wrong',
      recoverable: true,
    });

    const errors = sharedState.readErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBe('Something went wrong');
    expect(errors[0].recoverable).toBe(true);
  });

  it('skill loader loads and substitutes variables', () => {
    const { sharedState } = orchestrator.startMission({
      goal: 'Test skills',
      repoUrl: 'https://github.com/example/test.git',
    });

    const loader = new SkillLoader(sharedState);
    const prompt = loader.loadSkill('worker-implement', {
      feature_id: '#1',
      feature_title: 'Login Page',
      feature_description: 'Build a login page',
      acceptance_criteria: 'Page renders correctly',
      files: 'src/login.tsx',
      previous_handoff: 'None',
      what_remains: 'N/A',
    });

    expect(prompt).toContain('#1');
    expect(prompt).toContain('Login Page');
    expect(prompt).toContain('Build a login page');
    expect(prompt).toContain('src/login.tsx');
  });

  it('research findings are stored and retrieved', () => {
    const { sharedState } = orchestrator.startMission({
      goal: 'Test research',
      repoUrl: 'https://github.com/example/test.git',
    });

    sharedState.writeResearchFinding('finding-1', '# Research Result\n\nFound relevant code.');

    const findings = sharedState.readResearchFindings();
    expect(findings.size).toBe(1);
    expect(findings.get('finding-1')).toContain('Found relevant code');
  });

  it('mission with custom features and milestones', () => {
    const { sharedState } = orchestrator.startMission({
      goal: 'Custom mission',
      repoUrl: 'https://github.com/example/test.git',
    });

    const customFeatures: FeaturesFile = {
      mission_name: 'Custom multi-milestone mission',
      goal: 'Build full app',
      milestones: [
        { index: 0, name: 'Foundation', features: ['#1', '#2'], status: 'pending', retry_count: 0 },
        { index: 1, name: 'Features', features: ['#3'], status: 'pending', retry_count: 0 },
        { index: 2, name: 'Polish', features: ['#4'], status: 'pending', retry_count: 0 },
      ],
      features: [
        { id: '#1', title: 'Setup', description: 'Project setup', acceptance_criteria: ['Runs'], files: ['package.json'], status: 'pending', assigned_worker: null },
        { id: '#2', title: 'Database', description: 'DB layer', acceptance_criteria: ['Connects'], files: ['src/db.ts'], status: 'pending', assigned_worker: null },
        { id: '#3', title: 'API', description: 'REST API', acceptance_criteria: ['Responds'], files: ['src/api.ts'], status: 'pending', assigned_worker: null },
        { id: '#4', title: 'Tests', description: 'Test suite', acceptance_criteria: ['Passes'], files: ['tests/'], status: 'pending', assigned_worker: null },
      ],
      current_milestone_index: 0,
    };

    sharedState.writeFeatures(customFeatures);

    const read = sharedState.readFeatures();
    expect(read.milestones).toHaveLength(3);
    expect(read.features).toHaveLength(4);
    expect(read.milestones[0].features).toEqual(['#1', '#2']);
  });
});
