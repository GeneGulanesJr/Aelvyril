import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runResearchSubagent } from '../../src/missions/research-subagent.js';
import { SharedState } from '../../src/missions/shared-state.js';
import type { FeaturesFile, ModelAssignment, ResearchConfig } from '../../src/missions/missions.types.js';

function createMockPool() {
  return {
    spawnEphemeral: vi.fn().mockReturnValue({ getStatus: () => ({ running: false }) }),
    get: vi.fn().mockReturnValue(null),
    kill: vi.fn(),
  } as any;
}

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

function makeConfig(tmpDir: string, scope: ResearchConfig['scope'] = 'codebase'): ResearchConfig {
  return {
    sessionId: 'session-123',
    sharedStateDir: tmpDir,
    query: 'How does authentication work?',
    scope,
  };
}

describe('runResearchSubagent', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-research-'));
    const sharedState = new SharedState(tmpDir);
    sharedState.initialize(makeFeatures(), defaultModels);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('spawns ephemeral agent with correct agentType and env vars', async () => {
    const pool = createMockPool();
    const config = makeConfig(tmpDir);

    await runResearchSubagent(config, pool);

    expect(pool.spawnEphemeral).toHaveBeenCalledTimes(1);
    const call = pool.spawnEphemeral.mock.calls[0];

    expect(call[0]).toMatch(/^research-[0-9a-f]{8}$/);
    expect(call[1]).toBe('session-123');
    expect(call[2]).toBe('');
    expect(call[3]).toBe('research_subagent');

    const env = call[4];
    expect(env.AELVYRIL_RESEARCH_QUERY).toBe('How does authentication work?');
    expect(env.AELVYRIL_RESEARCH_SCOPE).toBe('codebase');
    expect(env.AELVYRIL_MISSION_DIR).toBe(tmpDir);
  });

  it('writes a finding file to research-findings/ in shared state', async () => {
    const pool = createMockPool();
    const config = makeConfig(tmpDir);

    const findingId = await runResearchSubagent(config, pool);

    const findingsDir = path.join(tmpDir, 'research-findings');
    const findingPath = path.join(findingsDir, `${findingId}.md`);
    expect(fs.existsSync(findingPath)).toBe(true);

    const content = fs.readFileSync(findingPath, 'utf-8');
    expect(content).toContain('# Research Finding');
    expect(content).toContain('How does authentication work?');
    expect(content).toContain('codebase');
  });

  it('returns a finding ID string with correct format', async () => {
    const pool = createMockPool();
    const config = makeConfig(tmpDir);

    const findingId = await runResearchSubagent(config, pool);

    expect(typeof findingId).toBe('string');
    expect(findingId).toMatch(/^finding-\d+-[0-9a-f]{8}$/);
  });

  it('passes scope through env var for docs scope', async () => {
    const pool = createMockPool();
    const config = makeConfig(tmpDir, 'docs');

    await runResearchSubagent(config, pool);

    const env = pool.spawnEphemeral.mock.calls[0][4];
    expect(env.AELVYRIL_RESEARCH_SCOPE).toBe('docs');
  });

  it('passes scope through env var for web scope', async () => {
    const pool = createMockPool();
    const config = makeConfig(tmpDir, 'web');

    await runResearchSubagent(config, pool);

    const env = pool.spawnEphemeral.mock.calls[0][4];
    expect(env.AELVYRIL_RESEARCH_SCOPE).toBe('web');
  });

  it('uses skill prompt when research-subagent.md exists in agent-skills/', async () => {
    const pool = createMockPool();
    const config = makeConfig(tmpDir);

    const skillContent = 'Custom research skill for {{query}} with scope {{scope}}';
    const skillsDir = path.join(tmpDir, 'agent-skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'research-subagent.md'), skillContent, 'utf-8');

    const findingId = await runResearchSubagent(config, pool);

    expect(typeof findingId).toBe('string');
    expect(pool.spawnEphemeral).toHaveBeenCalledTimes(1);

    const findingsDir = path.join(tmpDir, 'research-findings');
    const findingPath = path.join(findingsDir, `${findingId}.md`);
    expect(fs.existsSync(findingPath)).toBe(true);
  });

  it('falls back to inline prompt when research-subagent.md does not exist', async () => {
    const pool = createMockPool();
    const config = makeConfig(tmpDir);

    const skillFile = path.join(tmpDir, 'agent-skills', 'research-subagent.md');
    if (fs.existsSync(skillFile)) {
      fs.unlinkSync(skillFile);
    }

    const findingId = await runResearchSubagent(config, pool);

    expect(typeof findingId).toBe('string');
    expect(pool.spawnEphemeral).toHaveBeenCalledTimes(1);
  });

  it('generates unique finding IDs across multiple calls', async () => {
    const pool = createMockPool();
    const config = makeConfig(tmpDir);

    const id1 = await runResearchSubagent(config, pool);
    const id2 = await runResearchSubagent(config, pool);

    expect(id1).not.toBe(id2);
  });

  it('includes agent ID in the finding content', async () => {
    const pool = createMockPool();
    const config = makeConfig(tmpDir);

    const findingId = await runResearchSubagent(config, pool);
    const findingPath = path.join(tmpDir, 'research-findings', `${findingId}.md`);
    const content = fs.readFileSync(findingPath, 'utf-8');

    const agentId = pool.spawnEphemeral.mock.calls[0][0];
    expect(content).toContain(agentId);
  });
});
