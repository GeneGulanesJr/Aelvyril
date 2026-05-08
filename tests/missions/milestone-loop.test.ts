import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MilestoneLoop } from '../../src/missions/milestone-loop.js';
import { SharedState } from '../../src/missions/shared-state.js';
import type { FeaturesFile, ModelAssignment } from '../../src/missions/missions.types.js';
import { BoardEvents } from '../../src/board/board-events.js';

vi.mock('../../src/agents/main-agent/git-operations.js', () => ({
  createTicketBranch: vi.fn(),
}));

const defaultModels: ModelAssignment = {
  orchestrator: 'claude-sonnet-4-20250514',
  worker: 'gpt-4o',
  scrutiny_validator: 'claude-sonnet-4-20250514',
  user_testing_validator: 'claude-sonnet-4-20250514',
  research_subagent: 'gpt-4o-mini',
};

function makeFeatures(overrides: Partial<FeaturesFile> = {}): FeaturesFile {
  return {
    mission_name: 'Test Mission',
    goal: 'Test goal',
    milestones: [
      { index: 0, name: 'Phase 1', features: ['#1'], status: 'pending', retry_count: 0 },
      { index: 1, name: 'Phase 2', features: ['#2'], status: 'pending', retry_count: 0 },
    ],
    features: [
      { id: '#1', title: 'Feature 1', description: 'First feature', acceptance_criteria: ['Works'], files: ['src/a.ts'], status: 'pending', assigned_worker: null },
      { id: '#2', title: 'Feature 2', description: 'Second feature', acceptance_criteria: ['Works'], files: ['src/b.ts'], status: 'pending', assigned_worker: null },
    ],
    current_milestone_index: 0,
    ...overrides,
  };
}

function createMockSessionManager(tmpDir: string) {
  return {
    findRecoverable: vi.fn().mockReturnValue([{
      id: 'test-session',
      repo_path: path.join(tmpDir, 'repo'),
      memory_db_path: path.join(tmpDir, 'memory.db'),
    }]),
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    complete: vi.fn(),
  } as any;
}

function createMockPool() {
  return {
    spawnEphemeral: vi.fn().mockReturnValue({ getStatus: () => ({ running: false }) }),
    get: vi.fn().mockReturnValue(null),
    kill: vi.fn(),
    killAll: vi.fn(),
    killEphemeral: vi.fn(),
    getAllStatuses: vi.fn().mockReturnValue(new Map()),
    getByAgentType: vi.fn().mockReturnValue([]),
  } as any;
}

describe('MilestoneLoop', () => {
  let tmpDir: string;
  let sharedState: SharedState;
  let pool: ReturnType<typeof createMockPool>;
  let sessionManager: ReturnType<typeof createMockSessionManager>;
  let boardEvents: BoardEvents;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-loop-'));
    fs.mkdirSync(path.join(tmpDir, 'repo'), { recursive: true });
    pool = createMockPool();
    sessionManager = createMockSessionManager(tmpDir);
    boardEvents = new BoardEvents();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function initLoop(features: FeaturesFile): MilestoneLoop {
    sharedState = new SharedState(tmpDir);
    sharedState.initialize(features, defaultModels);
    return new MilestoneLoop(sharedState, pool, sessionManager, boardEvents);
  }

  it('single milestone with one feature returns done', async () => {
    const features = makeFeatures({
      milestones: [
        { index: 0, name: 'Phase 1', features: ['#1'], status: 'pending', retry_count: 0 },
      ],
      features: [
        { id: '#1', title: 'Feature 1', description: 'First feature', acceptance_criteria: ['Works'], files: ['src/a.ts'], status: 'pending', assigned_worker: null },
      ],
    });
    const loop = initLoop(features);
    const result = await loop.run();

    expect(result.status).toBe('done');
    expect(result.milestones_completed).toBe(1);
    expect(result.features_completed).toBe(1);

    const finalFeatures = sharedState.readFeatures();
    expect(finalFeatures.features[0].status).toBe('done');
  });

  it('two milestones process sequentially', async () => {
    const loop = initLoop(makeFeatures());
    const result = await loop.run();

    expect(result.status).toBe('done');
    expect(result.milestones_completed).toBe(2);
    expect(result.features_completed).toBe(2);
  });

  it('milestone with all features already done is skipped', async () => {
    const features = makeFeatures({
      features: [
        { id: '#1', title: 'Feature 1', description: 'First feature', acceptance_criteria: ['Works'], files: ['src/a.ts'], status: 'done', assigned_worker: null },
        { id: '#2', title: 'Feature 2', description: 'Second feature', acceptance_criteria: ['Works'], files: ['src/b.ts'], status: 'pending', assigned_worker: null },
      ],
    });
    const loop = initLoop(features);
    const result = await loop.run();

    expect(result.status).toBe('done');
    expect(result.milestones_completed).toBe(2);
    expect(result.features_completed).toBe(1);
    expect(pool.spawnEphemeral).toHaveBeenCalledTimes(1);
  });

  it('MissionResult has correct fields and duration_ms > 0', async () => {
    const loop = initLoop(makeFeatures());
    const result = await loop.run();

    expect(result.mission_id).toBeDefined();
    expect(typeof result.mission_id).toBe('string');
    expect(result.milestones_completed).toBe(2);
    expect(result.features_completed).toBe(2);
    expect(result.duration_ms).toBeGreaterThan(0);
    expect(result.milestones_total).toBe(2);
    expect(result.features_total).toBe(2);
    expect(Array.isArray(result.handoffs)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it('MissionResult.status is done when all milestones done', async () => {
    const loop = initLoop(makeFeatures());
    const result = await loop.run();
    expect(result.status).toBe('done');
  });

  it('worker spawns produce handoffs in shared state', async () => {
    const loop = initLoop(makeFeatures());
    const result = await loop.run();

    expect(result.handoffs).toHaveLength(2);
    const featureIds = result.handoffs.map(h => h.feature_id).sort();
    expect(featureIds).toEqual(['#1', '#2']);
  });

  it('validation contract is written and locked during each milestone', async () => {
    const loop = initLoop(makeFeatures());
    const writeSpy = vi.spyOn(sharedState, 'writeValidationContract');
    const lockSpy = vi.spyOn(sharedState, 'lockValidationContract');

    await loop.run();

    expect(writeSpy).toHaveBeenCalledTimes(2);
    expect(lockSpy).toHaveBeenCalledTimes(2);

    const contract = sharedState.readValidationContract();
    expect(contract).toBeNull();
  });
});
