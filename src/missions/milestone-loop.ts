import type { AgentPool } from '../agents/agent-pool.js';
import type { BoardEvents } from '../board/board-events.js';
import type { SessionManager } from '../sessions/session-manager.js';
import type {
  FeaturesFile,
  Milestone,
  Feature,
  MissionResult,
  ValidationVerdict,
  ValidationContract,
} from './missions.types.js';
import { SharedState } from './shared-state.js';
import { ValidationContractManager } from './validation-contract.js';
import { ModelAssignmentManager } from './model-assignment.js';
import { negotiate } from './negotiation.js';
import { BroadcastManager } from './broadcast.js';
import { runWorker } from './worker-agent.js';

export class MilestoneLoop {
  private broadcast: BroadcastManager;

  constructor(
    private sharedState: SharedState,
    private agentPool: AgentPool,
    private sessionManager: SessionManager,
    private boardEvents: BoardEvents,
  ) {
    this.broadcast = new BroadcastManager(sharedState);
  }

  async run(): Promise<MissionResult> {
    const startTime = Date.now();
    const missionId = this.sharedState.getMissionDir().split('/').pop() ?? 'unknown';
    const features = this.sharedState.readFeatures();

    let milestonesCompleted = 0;
    let featuresCompleted = 0;

    for (let i = 0; i < features.milestones.length; ) {
      const milestone = features.milestones[i];
      if (milestone.status === 'done') {
        i++;
        continue;
      }

      this.broadcast.publish('orchestrator', 'status', `Starting milestone ${milestone.name}`);

      const contract = this.buildValidationContract(milestone, features);
      this.sharedState.writeValidationContract(contract);
      this.sharedState.lockValidationContract();

      for (const featureId of milestone.features) {
        const feature = features.features.find(f => f.id === featureId);
        if (!feature || feature.status === 'done') continue;

        try {
          this.sharedState.acquireWorkerLock(`worker-${featureId}`, featureId);
        } catch {
          throw new Error(`Cannot spawn worker for ${featureId}: worker slot occupied`);
        }

        try {
          this.sharedState.updateFeatureStatus(featureId, 'in_progress');
          const session = this.findSession();
          if (!session) throw new Error('No session found');

          await runWorker(
            {
              featureId,
              milestoneIndex: milestone.index,
              sessionId: session.id,
              workspacePath: session.repo_path,
              memoryDbPath: session.memory_db_path,
              sharedStateDir: this.sharedState.getMissionDir(),
            },
            this.agentPool,
          );

          featuresCompleted++;
          this.boardEvents.emit('agent_activity', {
            agent: 'WORKER',
            action: `Completed ${featureId}`,
          });
        } catch (err) {
          this.sharedState.updateFeatureStatus(featureId, 'failed');
          this.sharedState.appendError({
            timestamp: new Date().toISOString(),
            agent: 'worker',
            feature_id: featureId,
            error: err instanceof Error ? err.message : String(err),
            recoverable: true,
          });
        } finally {
          this.sharedState.releaseWorkerLock();
        }
      }

      const [scrutinyResult, userTestingResult] = await Promise.all([
        this.spawnScrutinyValidator(milestone),
        this.spawnUserTestingValidator(milestone),
      ]);

      const refreshedFeatures = this.sharedState.readFeatures();
      const refreshedMilestone = refreshedFeatures.milestones[i];
      const verdict = negotiate(
        scrutinyResult,
        userTestingResult,
        refreshedMilestone,
        this.sharedState.readHandoffs(),
        this.sharedState.readErrors(),
      );

      if (verdict.action === 'accept') {
        milestonesCompleted++;
        this.sharedState.advanceMilestone();
        this.broadcast.publish('orchestrator', 'status', `Milestone ${milestone.name} accepted`);
        i++;
      } else if (verdict.action === 'rescope' && verdict.rescope_changes) {
        const currentFeatures = this.sharedState.readFeatures();
        currentFeatures.milestones[i].retry_count++;
        for (const fid of verdict.rescope_changes.features_to_retry) {
          const f = currentFeatures.features.find(feat => feat.id === fid);
          if (f) f.status = 'pending';
        }
        this.sharedState.writeFeatures(currentFeatures);
        this.broadcast.publish('orchestrator', 'status', `Milestone ${milestone.name} rescoped: ${verdict.reason}`);
        // do NOT increment i — re-run this milestone
      } else {
        this.broadcast.publish('orchestrator', 'status', `Mission blocked: ${verdict.reason}`);
        break;
      }
    }

    const finalFeatures = this.sharedState.readFeatures();
    return {
      mission_id: missionId,
      status: finalFeatures.milestones.every(m => m.status === 'done') ? 'done' : 'blocked',
      milestones_completed: milestonesCompleted,
      milestones_total: finalFeatures.milestones.length,
      features_completed: featuresCompleted,
      features_total: finalFeatures.features.length,
      handoffs: this.sharedState.readHandoffs(),
      errors: this.sharedState.readErrors(),
      duration_ms: Date.now() - startTime,
    };
  }

  private buildValidationContract(milestone: Milestone, features: FeaturesFile): ValidationContract {
    return {
      milestone_index: milestone.index,
      milestone_name: milestone.name,
      features: milestone.features.map(fid => {
        const f = features.features.find(feat => feat.id === fid);
        return {
          feature_id: fid,
          feature_title: f?.title ?? fid,
          unit_test_assertions: f?.acceptance_criteria ?? [],
          integration_test_assertions: [],
          type_check_requirements: [],
        };
      }),
      functional_flows: [],
      created_at: new Date().toISOString(),
      locked: false,
    };
  }

  private async spawnScrutinyValidator(milestone: Milestone): Promise<ValidationVerdict> {
    return {
      passed: true,
      milestone_index: milestone.index,
      details: 'Scrutiny validation passed (default)',
      failed_features: [],
      failures: [],
    };
  }

  private async spawnUserTestingValidator(milestone: Milestone): Promise<ValidationVerdict> {
    return {
      passed: true,
      milestone_index: milestone.index,
      details: 'User testing validation passed (default)',
      failed_features: [],
      failures: [],
    };
  }

  private findSession(): { id: string; repo_path: string; memory_db_path: string } | null {
    const recoverable = this.sessionManager.findRecoverable();
    return recoverable.length > 0 ? recoverable[0] : null;
  }
}
