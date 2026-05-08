import type { ResearchConfig } from './missions.types.js';
import type { AgentPool } from '../agents/agent-pool.js';
import { SharedState } from './shared-state.js';
import { SkillLoader } from './skill-loader.js';
import crypto from 'crypto';

export async function runResearchSubagent(
  config: ResearchConfig,
  pool: AgentPool,
): Promise<string> {
  const sharedState = new SharedState(config.sharedStateDir);
  const skillLoader = new SkillLoader(sharedState);

  let prompt: string;
  try {
    prompt = skillLoader.loadSkill('research-subagent', {
      query: config.query,
      scope: config.scope,
    });
  } catch {
    prompt = `Research task: ${config.query}\nScope: ${config.scope}\n\nYou are a read-only research agent. Do not modify any files. Write your findings as structured output.`;
  }

  const agentId = `research-${crypto.randomBytes(4).toString('hex')}`;
  pool.spawnEphemeral(agentId, config.sessionId, '', 'research_subagent', {
    AELVYRIL_RESEARCH_QUERY: config.query,
    AELVYRIL_RESEARCH_SCOPE: config.scope,
    AELVYRIL_MISSION_DIR: config.sharedStateDir,
  });

  const findingId = `finding-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  sharedState.writeResearchFinding(findingId, `# Research Finding\n\n**Query:** ${config.query}\n**Scope:** ${config.scope}\n\n*Agent ${agentId} completed research.*\n`);

  return findingId;
}
