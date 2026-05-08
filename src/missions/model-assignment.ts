import type { SharedState } from './shared-state.js';
import type { ModelAssignment } from './missions.types.js';

export const DEFAULT_MODEL_ASSIGNMENT: ModelAssignment = {
  orchestrator: 'claude-sonnet-4-20250514',
  worker: 'gpt-4o',
  scrutiny_validator: 'claude-sonnet-4-20250514',
  user_testing_validator: 'claude-sonnet-4-20250514',
  research_subagent: 'gpt-4o-mini',
};

export class ModelAssignmentManager {
  constructor(private sharedState: SharedState) {}

  load(): ModelAssignment {
    const stored = this.sharedState.readModelAssignment();
    return stored ?? { ...DEFAULT_MODEL_ASSIGNMENT };
  }

  update(partial: Partial<ModelAssignment>): void {
    const current = this.load();
    this.sharedState.writeModelAssignment({ ...current, ...partial });
  }

  resolveForAgentType(agentType: string): string {
    const models = this.load();
    const mapping: Record<string, string> = {
      orchestrator: models.orchestrator,
      worker: models.worker,
      scrutiny_validator: models.scrutiny_validator,
      user_testing_validator: models.user_testing_validator,
      research_subagent: models.research_subagent,
    };
    const model = mapping[agentType];
    if (!model) throw new Error(`Unknown agent type: ${agentType}`);
    return model;
  }
}
