export interface Feature {
  id: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
  files: string[];
  status: 'pending' | 'in_progress' | 'done' | 'failed';
  assigned_worker: string | null;
}

export interface Milestone {
  index: number;
  name: string;
  features: string[];
  status: 'pending' | 'in_progress' | 'done' | 'failed';
  retry_count: number;
}

export interface FeaturesFile {
  mission_name: string;
  goal: string;
  milestones: Milestone[];
  features: Feature[];
  current_milestone_index: number;
}

export interface HandoffEntry {
  timestamp: string;
  feature_id: string;
  milestone_index: number;
  worker_id: string;
  what_was_implemented: string;
  what_remains: string;
  errors_encountered: string[];
  commands_run: string[];
  exit_codes: Record<string, number>;
  git_commit_hash: string;
}

export interface ModelAssignment {
  orchestrator: string;
  worker: string;
  scrutiny_validator: string;
  user_testing_validator: string;
  research_subagent: string;
}

export interface BroadcastEntry {
  timestamp: string;
  from: string;
  type: 'status' | 'constraint' | 'context';
  message: string;
}

export interface ErrorEntry {
  timestamp: string;
  agent: string;
  feature_id: string | null;
  error: string;
  recoverable: boolean;
}

export interface CommandEntry {
  timestamp: string;
  agent: string;
  command: string;
  exit_code: number;
  duration_ms: number;
}

export type MissionStatus = 'planning' | 'executing' | 'validating' | 'negotiating' | 'done' | 'blocked';

export interface StartMissionRequest {
  goal: string;
  repoUrl: string;
  context?: string;
}

export interface MissionResult {
  mission_id: string;
  status: MissionStatus;
  milestones_completed: number;
  milestones_total: number;
  features_completed: number;
  features_total: number;
  handoffs: HandoffEntry[];
  errors: ErrorEntry[];
  duration_ms: number;
}

export interface ValidationContract {
  milestone_index: number;
  milestone_name: string;
  features: Array<{
    feature_id: string;
    feature_title: string;
    unit_test_assertions: string[];
    integration_test_assertions: string[];
    type_check_requirements: string[];
  }>;
  functional_flows: Array<{
    name: string;
    steps: string[];
  }>;
  created_at: string;
  locked: boolean;
}

export interface ValidationVerdict {
  passed: boolean;
  milestone_index: number;
  details: string;
  failed_features: string[];
  failures: Array<{
    feature_id: string;
    assertion: string;
    expected: string;
    actual: string;
  }>;
}

export interface NegotiationVerdict {
  action: 'accept' | 'rescope' | 'block';
  reason: string;
  rescope_changes?: {
    features_to_retry: string[];
    features_to_drop: string[];
    features_to_add: Feature[];
    updated_milestone_name?: string;
  };
}

export interface WorkerConfig {
  featureId: string;
  milestoneIndex: number;
  sessionId: string;
  workspacePath: string;
  memoryDbPath: string;
  sharedStateDir: string;
}

export interface WorkerResult {
  feature_id: string;
  success: boolean;
  handoff: HandoffEntry | null;
}

export interface ResearchConfig {
  sessionId: string;
  sharedStateDir: string;
  query: string;
  scope: 'codebase' | 'docs' | 'web';
}
