import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SharedState } from '../../src/missions/shared-state.js';
import type { FeaturesFile, ModelAssignment, WorkerConfig } from '../../src/missions/missions.types.js';

vi.mock('../../src/agents/main-agent/git-operations.js', () => ({
  createTicketBranch: vi.fn(),
}));

import { runWorker } from '../../src/missions/worker-agent.js';
import { createTicketBranch } from '../../src/agents/main-agent/git-operations.js';

const mockedCreateTicketBranch = vi.mocked(createTicketBranch);

function makeFeatures(): FeaturesFile {
  return {
    mission_name: 'test-mission',
    goal: 'Test goal',
    milestones: [
      { index: 0, name: 'M1', features: ['#1'], status: 'pending', retry_count: 0 },
    ],
    features: [
      { id: '#1', title: 'Feature One', description: 'Implement feature one', acceptance_criteria: ['Works correctly', 'Handles errors'], files: ['src/feature.ts'], status: 'pending', assigned_worker: null },
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

function createMockPool() {
  return {
    spawnEphemeral: vi.fn().mockReturnValue({ getStatus: () => ({ running: false }) }),
    get: vi.fn().mockReturnValue(null),
    kill: vi.fn(),
    killAll: vi.fn(),
    killEphemeral: vi.fn(),
    getAllStatuses: vi.fn().mockReturnValue(new Map()),
    getByAgentType: vi.fn().mockReturnValue([]),
    spawnLongRunning: vi.fn().mockReturnValue({ getStatus: () => ({ running: false }) }),
  } as any;
}

describe('runWorker', () => {
  let tmpDir: string;
  let sharedState: SharedState;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-worker-'));
    sharedState = new SharedState(tmpDir);
    sharedState.initialize(makeFeatures(), defaultModels);
    mockedCreateTicketBranch.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads feature spec from features.json', async () => {
    const pool = createMockPool();
    const result = await runWorker({
      featureId: '#1',
      milestoneIndex: 0,
      sessionId: 'test-session',
      workspacePath: tmpDir,
      memoryDbPath: path.join(tmpDir, 'memory.db'),
      sharedStateDir: tmpDir,
    }, pool);

    expect(result.feature_id).toBe('#1');
    expect(result.success).toBe(true);
  });

  it('creates git branch via createTicketBranch', async () => {
    const pool = createMockPool();
    await runWorker({
      featureId: '#1',
      milestoneIndex: 0,
      sessionId: 'test-session',
      workspacePath: tmpDir,
      memoryDbPath: path.join(tmpDir, 'memory.db'),
      sharedStateDir: tmpDir,
    }, pool);

    expect(mockedCreateTicketBranch).toHaveBeenCalledWith(tmpDir, '#1', 'test-session');
  });

  it('spawns ephemeral agent with correct env vars', async () => {
    const pool = createMockPool();
    await runWorker({
      featureId: '#1',
      milestoneIndex: 0,
      sessionId: 'test-session',
      workspacePath: tmpDir,
      memoryDbPath: path.join(tmpDir, 'memory.db'),
      sharedStateDir: tmpDir,
    }, pool);

    expect(pool.spawnEphemeral).toHaveBeenCalledTimes(1);
    const [agentId, sessionId, memoryDbPath, agentType, env] = pool.spawnEphemeral.mock.calls[0];
    expect(agentId).toContain('worker-#1-');
    expect(sessionId).toBe('test-session');
    expect(agentType).toBe('worker');
    expect(env.AELVYRIL_TICKET_ID).toBe('#1');
    expect(env.AELVYRIL_WORKSPACE).toBe(tmpDir);
    expect(env.AELVYRIL_TICKET_PROMPT).toBeDefined();
    expect(env.AELVYRIL_TICKET_PROMPT).toContain('Feature One');
    expect(env.AELVYRIL_TICKET_PROMPT).toContain('Implement feature one');
  });

  it('appends handoff to shared state', async () => {
    const pool = createMockPool();
    await runWorker({
      featureId: '#1',
      milestoneIndex: 0,
      sessionId: 'test-session',
      workspacePath: tmpDir,
      memoryDbPath: path.join(tmpDir, 'memory.db'),
      sharedStateDir: tmpDir,
    }, pool);

    const handoffs = sharedState.readHandoffs();
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].feature_id).toBe('#1');
    expect(handoffs[0].milestone_index).toBe(0);
    expect(handoffs[0].what_was_implemented).toBe('Feature One');
    expect(handoffs[0].worker_id).toContain('worker-#1-');
  });

  it('returns success result with handoff', async () => {
    const pool = createMockPool();
    const result = await runWorker({
      featureId: '#1',
      milestoneIndex: 0,
      sessionId: 'test-session',
      workspacePath: tmpDir,
      memoryDbPath: path.join(tmpDir, 'memory.db'),
      sharedStateDir: tmpDir,
    }, pool);

    expect(result).toEqual({
      feature_id: '#1',
      success: true,
      handoff: expect.objectContaining({
        feature_id: '#1',
        milestone_index: 0,
        what_was_implemented: 'Feature One',
      }),
    });
  });

  it('returns failure for missing feature ID', async () => {
    const pool = createMockPool();
    const result = await runWorker({
      featureId: '#999',
      milestoneIndex: 0,
      sessionId: 'test-session',
      workspacePath: tmpDir,
      memoryDbPath: path.join(tmpDir, 'memory.db'),
      sharedStateDir: tmpDir,
    }, pool);

    expect(result).toEqual({
      feature_id: '#999',
      success: false,
      handoff: null,
    });
  });

  it('reads latest handoff for context in skill prompt', async () => {
    sharedState.appendHandoff({
      timestamp: new Date().toISOString(),
      feature_id: '#1',
      milestone_index: 0,
      worker_id: 'previous-worker',
      what_was_implemented: 'Previous work',
      what_remains: 'Some remaining work',
      errors_encountered: [],
      commands_run: [],
      exit_codes: {},
      git_commit_hash: 'abc123',
    });

    const pool = createMockPool();
    await runWorker({
      featureId: '#1',
      milestoneIndex: 0,
      sessionId: 'test-session',
      workspacePath: tmpDir,
      memoryDbPath: path.join(tmpDir, 'memory.db'),
      sharedStateDir: tmpDir,
    }, pool);

    const env = pool.spawnEphemeral.mock.calls[0][4];
    expect(env.AELVYRIL_TICKET_PROMPT).toContain('Previous work');
  });
});
