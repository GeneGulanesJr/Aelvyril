import { execSync } from 'child_process';
import type { AgentPool } from '../agents/agent-pool.js';
import type { WorkerConfig, WorkerResult, HandoffEntry } from './missions.types.js';
import { SharedState } from './shared-state.js';
import { SkillLoader } from './skill-loader.js';
import { createTicketBranch } from '../agents/main-agent/git-operations.js';

export async function runWorker(
  config: WorkerConfig,
  pool: AgentPool,
): Promise<WorkerResult> {
  const sharedState = new SharedState(config.sharedStateDir);
  const features = sharedState.readFeatures();
  const feature = features.features.find(f => f.id === config.featureId);
  if (!feature) {
    return { feature_id: config.featureId, success: false, handoff: null };
  }

  const latestHandoff = sharedState.readLatestHandoff();
  const skillLoader = new SkillLoader(sharedState);
  let prompt: string;
  try {
    prompt = skillLoader.loadSkill('worker-implement', {
      feature_id: config.featureId,
      feature_title: feature.title,
      feature_description: feature.description,
      acceptance_criteria: feature.acceptance_criteria.join('\n'),
      files: feature.files.join(', '),
      previous_handoff: latestHandoff ? latestHandoff.what_was_implemented : 'None',
      what_remains: latestHandoff ? latestHandoff.what_remains : 'N/A',
    });
  } catch {
    prompt = `Implement feature ${config.featureId}: ${feature.title}\n\n${feature.description}\n\nAcceptance criteria:\n${feature.acceptance_criteria.join('\n')}\n\nFiles: ${feature.files.join(', ')}`;
  }

  createTicketBranch(config.workspacePath, config.featureId, config.sessionId);

  const agentId = `worker-${config.featureId}-${Date.now()}`;
  pool.spawnEphemeral(agentId, config.sessionId, config.memoryDbPath, 'worker', {
    AELVYRIL_TICKET_ID: config.featureId,
    AELVYRIL_WORKSPACE: config.workspacePath,
    AELVYRIL_TICKET_PROMPT: prompt,
  });

  let commitHash = '';
  try {
    commitHash = execSync('git rev-parse HEAD', { cwd: config.workspacePath, stdio: 'pipe' }).toString().trim();
  } catch {
    commitHash = 'unknown';
  }

  const handoff: HandoffEntry = {
    timestamp: new Date().toISOString(),
    feature_id: config.featureId,
    milestone_index: config.milestoneIndex,
    worker_id: agentId,
    what_was_implemented: feature.title,
    what_remains: '',
    errors_encountered: [],
    commands_run: [],
    exit_codes: {},
    git_commit_hash: commitHash,
  };

  sharedState.appendHandoff(handoff);
  sharedState.updateFeatureStatus(config.featureId, 'done');

  return { feature_id: config.featureId, success: true, handoff };
}
