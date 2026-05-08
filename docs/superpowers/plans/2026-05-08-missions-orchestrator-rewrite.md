# Missions Framework — Orchestrator Rewrite Plan

> Maps the Missions Framework v3 design onto the existing Aelvyril codebase.
> Each task is incremental, testable, and can be implemented by a single worker in isolation.

---

## What exists today

The current `Orchestrator` class (`src/orchestrator.ts`, 231 lines) is a session-level coordinator that:
- Creates sessions, spawns 3 long-running agents (supervisor, main_agent, watchdog)
- Routes chat messages through `ChatHandler`
- Dispatches tickets via `wave-executor` (parallel waves)
- Runs `TestAgent` then `ReviewAgent` per ticket
- Manages session lifecycle (destroy, shutdown)

**What's wrong with it for the Missions model:**
- No concept of milestones — tickets are dispatched in parallel waves, not serial milestone groups
- No shared file-system state — everything goes through SQLite + in-memory maps
- No validation contract — test/review happen per-ticket without an immutable contract
- No handoff log — no append-only memory between workers
- No negotiation step — failed tests just loop back to `in_progress`
- No research subagent tier
- No model assignment config — `AgentModelConfig` is hardcoded in `AelvyrilConfig`
- No `agent-skills/` prompt directory — prompts are embedded in TypeScript

---

## Target architecture

```
Shared State Directory (.aelvyril/missions/{mission-id}/)
├── features.json              ← full feature + milestone list
├── handoffs.jsonl             ← append-only worker handoff log
├── validation-contract.md     ← immutable per-milestone contract
├── model-assignment.json      ← model per agent role (swappable)
├── broadcasts.jsonl           ← all broadcast messages
├── error-log.jsonl            ← structured error entries
├── command-log.jsonl          ← all shell commands run
├── research-findings/         ← output from research subagents
│   ├── {finding-id}.md
│   └── ...
└── agent-skills/              ← prompt skill files (~700 lines total)
    ├── orchestrator-plan.md
    ├── orchestrator-negotiate.md
    ├── worker-implement.md
    ├── worker-handoff.md
    ├── scrutiny-validator.md
    ├── user-testing-validator.md
    └── research-subagent.md

Orchestrator (persistent process)
  ├── Milestone loop controller
  ├── SharedState (reads/writes files above)
  ├── Negotiation engine
  └── Agent spawner (delegates to AgentPool)

Worker (ephemeral, 1 active at a time)
  ├── Reads features.json + latest handoff
  ├── Implements feature
  ├── Commits to git
  └── Appends to handoffs.jsonl

Validators (spawned in parallel after all workers)
  ├── ScrutinyValidator — tests, lint, type-check, code review sub-agents
  └── UserTestingValidator — computer-use flows

ResearchSubagent (always parallel, read-only)
  ├── Never touches codebase
  └── Writes findings to research-findings/
```

---

## Implementation tasks

### Task 1: Shared state file system layer

**Files to create:**
- `src/missions/shared-state.ts`
- `tests/missions/shared-state.test.ts`

**Replace:** Nothing yet — additive.

Build a `SharedState` class that manages the mission directory. It wraps all file I/O for the shared state directory and provides typed read/write methods.

```typescript
export class SharedState {
  constructor(private missionDir: string) {}

  // features.json
  readFeatures(): FeaturesFile
  writeFeatures(features: FeaturesFile): void
  advanceMilestone(): void

  // handoffs.jsonl
  appendHandoff(entry: HandoffEntry): void
  readHandoffs(): HandoffEntry[]
  readLatestHandoff(): HandoffEntry | null

  // validation-contract.md
  writeValidationContract(content: string): void
  readValidationContract(): string | null

  // model-assignment.json
  readModelAssignment(): ModelAssignment
  writeModelAssignment(config: ModelAssignment): void

  // broadcasts.jsonl
  appendBroadcast(entry: BroadcastEntry): void
  readBroadcasts(sinceIndex?: number): BroadcastEntry[]

  // error-log.jsonl
  appendError(entry: ErrorEntry): void
  readErrors(): ErrorEntry[]

  // command-log.jsonl
  appendCommand(entry: CommandEntry): void

  // research-findings/
  writeResearchFinding(id: string, content: string): void
  readResearchFindings(): Map<string, string>

  // lifecycle
  initialize(features: FeaturesFile, models: ModelAssignment): void
  getMissionDir(): string
}
```

**Types to add to `src/missions/missions.types.ts`:**

```typescript
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
  features: string[];  // feature IDs
  status: 'pending' | 'in_progress' | 'done' | 'failed';
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
```

**Tests:**
- Initialize creates directory structure with all files
- Append/read handoffs works correctly
- Features can be updated and milestone advanced
- Validation contract is immutable within milestone (write once, read many)
- Broadcasts are append-only and readable
- JSONL files handle concurrent appends (use atomic append via `fs.appendFileSync`)
- Reading empty files returns appropriate defaults

---

### Task 2: Agent skills directory and loader

**Files to create:**
- `src/missions/skill-loader.ts`
- `src/missions/skills/` (directory for prompt templates — see below)
- `tests/missions/skill-loader.test.ts`

**Replace:** Nothing — new addition.

Create a `SkillLoader` that reads prompt skill files from the `agent-skills/` directory inside shared state. Each skill is a markdown file with frontmatter metadata.

```typescript
export class SkillLoader {
  constructor(private sharedState: SharedState) {}

  loadSkill(name: string): string  // reads agent-skills/{name}.md
  listSkills(): string[]
}
```

**Default skill files to seed** (total target: ~700 lines across all files):

| File | Purpose | Rough size |
|------|---------|-----------|
| `orchestrator-plan.md` | How the orchestrator decomposes a goal into milestones + features | ~120 lines |
| `orchestrator-negotiate.md` | How the orchestrator evaluates handoffs, accepts/rejects/re-scopes | ~100 lines |
| `worker-implement.md` | How a worker reads spec, implements code, commits, exits | ~100 lines |
| `worker-handoff.md` | Handoff entry format, what to include | ~40 lines |
| `scrutiny-validator.md` | Test suite, lint, type-check, code review sub-agent delegation | ~120 lines |
| `user-testing-validator.md` | Computer-use functional flow verification | ~100 lines |
| `research-subagent.md` | Read-only exploration, how to write findings | ~60 lines |

**Why a loader and not raw `fs.readFileSync`:** The loader resolves paths through `SharedState`, validates that the skill exists before returning, and can inject runtime variables (feature ID, milestone index) into templates using a simple `{{variable}}` substitution.

**Tests:**
- Loader reads a skill file and returns its contents
- Loader lists all available skills
- Variable substitution works
- Missing skill throws descriptive error

---

### Task 3: Handoff append/read with JSONL

**Files to create:**
- `src/missions/handoff-log.ts`
- `tests/missions/handoff-log.test.ts`

**Replace:** Nothing yet — extracted from the future `SharedState` for testability.

A focused class for the handoff log, since it's the most-read file in the system and needs to be bulletproof.

```typescript
export class HandoffLog {
  constructor(private filePath: string) {}

  append(entry: HandoffEntry): void  // atomic append, one JSON object per line
  readAll(): HandoffEntry[]
  readLatest(): HandoffEntry | null
  readLatestForFeature(featureId: string): HandoffEntry | null
  readForMilestone(milestoneIndex: number): HandoffEntry[]
  count(): number
}
```

**Implementation details:**
- Use `fs.appendFileSync` with a trailing `\n` for atomic writes
- Parse with `String.split('\n').filter(Boolean).map(JSON.parse)` wrapped in try/catch per line (corrupted lines are logged but don't crash the reader)
- Include a file lock advisory check (optional, document as future improvement)

**Tests:**
- Append one entry, read it back
- Append multiple entries, read all
- Read latest entry is correct
- Read latest for specific feature
- Corrupted line in middle doesn't break reads
- Empty file returns empty array/null

---

### Task 4: New orchestrator types and AgentType expansion

**Files to modify:**
- `src/types/common.ts` — add new agent types and mission-related types

**Replace:** The existing `AgentType` union expands from 7 to 10 values.

```typescript
// Before:
export type AgentType = 'supervisor' | 'ticket' | 'main' | 'sub' | 'test' | 'review' | 'watchdog';

// After:
export type AgentType =
  | 'supervisor' | 'ticket' | 'main' | 'sub' | 'test' | 'review' | 'watchdog'  // legacy
  | 'orchestrator' | 'worker' | 'scrutiny_validator' | 'user_testing_validator' | 'research_subagent';  // missions
```

Add mission status types:

```typescript
export type MissionStatus = 'planning' | 'executing' | 'validating' | 'negotiating' | 'done' | 'blocked';
```

**Migration note:** The existing `AgentModelConfig` interface in `common.ts` uses the old agent types as keys. Add a separate `MissionsModelConfig` that maps the new agent types, or unify by making the key type `string`. For now, keep them separate — `AgentModelConfig` for legacy, `ModelAssignment` (from `missions.types.ts`) for missions.

**Tests:**
- Verify the new `AgentType` values compile and are assignable
- Verify existing code using old agent types still compiles

---

### Task 5: Validation contract writer

**Files to create:**
- `src/missions/validation-contract.ts`
- `tests/missions/validation-contract.test.ts`

**Replace:** Nothing — new.

The orchestrator writes a validation contract before any worker runs for a milestone. This class manages the lifecycle.

```typescript
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
    steps: string[];  // e.g., "Navigate to /settings", "Click 'Save'", "Verify toast appears"
  }>;
  created_at: string;
  locked: boolean;
}

export class ValidationContractManager {
  constructor(private sharedState: SharedState) {}

  write(contract: ValidationContract): void   // fails if one already exists for this milestone
  read(): ValidationContract | null
  lock(): void                                 // sets locked=true, makes file immutable
  isLocked(): boolean
}
```

**Immutability enforcement:** The `write` method checks if a contract already exists for the current milestone. If it does and `locked` is true, it throws. The orchestrator can only replace it between milestones (after calling `SharedState.advanceMilestone()`).

**Tests:**
- Write a new contract
- Read it back correctly
- Writing when locked throws
- Locking persists across reads
- New milestone allows new write

---

### Task 6: Model assignment config

**Files to create:**
- `src/missions/model-assignment.ts`
- `tests/missions/model-assignment.test.ts`

**Replace:** The hardcoded model strings in `ConfigManager`'s defaults for missions agents. Legacy `AgentModelConfig` remains untouched.

```typescript
export const DEFAULT_MODEL_ASSIGNMENT: ModelAssignment = {
  orchestrator: 'claude-sonnet-4-20250514',
  worker: 'gpt-4o',
  scrutiny_validator: 'claude-sonnet-4-20250514',
  user_testing_validator: 'claude-sonnet-4-20250514',  // must be computer-use-capable
  research_subagent: 'gpt-4o-mini',
};

export class ModelAssignmentManager {
  constructor(private sharedState: SharedState) {}

  load(): ModelAssignment
  update(partial: Partial<ModelAssignment>): void
  resolveForAgentType(agentType: string): string  // maps agent type string to model
}
```

The config lives in `model-assignment.json` inside shared state, so it can be changed between missions without touching `AelvyrilConfig`.

**Tests:**
- Load defaults when no file exists
- Update persists
- Resolve returns correct model for each agent type
- Unknown agent type throws

---

### Task 7: Orchestrator milestone loop controller

**Files to create:**
- `src/missions/milestone-loop.ts`
- `tests/missions/milestone-loop.test.ts`

**Replace:** The `processTickets` and `runTests`/`runReview` methods in the current `Orchestrator` class. The old methods stay until Task 9 when the full Orchestrator is rewritten.

This is the core loop. It replaces the wave-based parallel dispatch with serial milestone execution.

```typescript
export class MilestoneLoop {
  private currentWorker: AgentProcess | null = null;

  constructor(
    private sharedState: SharedState,
    private agentPool: AgentPool,
    private sessionManager: SessionManager,
    private boardEvents: BoardEvents,
  ) {}

  async run(): Promise<MissionResult> {
    const features = this.sharedState.readFeatures();

    for (const milestone of features.milestones) {
      if (milestone.status === 'done') continue;

      // 1. Write validation contract
      const contract = await this.buildValidationContract(milestone, features);
      this.sharedState.writeValidationContract(contract);

      // 2. Serial worker execution
      for (const featureId of milestone.features) {
        const feature = features.features.find(f => f.id === featureId);
        if (!feature || feature.status === 'done') continue;

        await this.spawnWorker(feature, milestone.index);

        // Worker appends to handoffs.jsonl on exit
        // We wait for it
        await this.waitForWorkerCompletion(featureId);

        // 3. Read handoff and verify
        const handoff = this.sharedState.readLatestHandoff();
        if (handoff && handoff.feature_id === featureId) {
          // Update feature status
          this.updateFeatureStatus(featureId, 'done');
        }
      }

      // 4. Spawn validators in parallel
      const [scrutinyResult, userTestingResult] = await Promise.all([
        this.spawnScrutinyValidator(milestone),
        this.spawnUserTestingValidator(milestone),
      ]);

      // 5. Negotiation
      const verdict = this.negotiate(scrutinyResult, userTestingResult, milestone);

      if (verdict.action === 'accept') {
        this.advanceMilestone();
      } else if (verdict.action === 'rescope') {
        this.rescopeAndReassign(verdict, milestone);
        // Re-run this milestone (do not advance)
        continue;
      } else {
        // blocked
        break;
      }
    }

    return this.buildMissionResult();
  }

  private async spawnWorker(feature: Feature, milestoneIndex: number): Promise<void> {
    // Spawn ephemeral worker agent via AgentPool
    // Worker reads features.json + latest handoff from shared state
    // Worker implements, commits, appends handoff
    // Serial constraint: only one worker at a time
  }

  private async spawnScrutinyValidator(milestone: Milestone): Promise<ValidationVerdict> {
    // Runs test suite, linter, type checker
    // Can delegate to sub-agents per feature for code review
    // Reads validation-contract.md
    // Returns structured verdict
  }

  private async spawnUserTestingValidator(milestone: Milestone): Promise<ValidationVerdict> {
    // Computer-use agent
    // Reads functional flows from validation-contract.md
    // Executes each flow against live application
    // Returns structured verdict
  }

  private negotiate(
    scrutiny: ValidationVerdict,
    userTesting: ValidationVerdict,
    milestone: Milestone,
  ): NegotiationVerdict {
    // The only place re-scoping happens
    // If either validator failed, read failure details
    // Decide: accept (pass), rescope (retry with changes), or block
    // If rescope: update features.json with revised scope
    // Never modify validation-contract.md mid-milestone
  }
}
```

**Key constraint enforcement:**
- `spawnWorker` checks that no other worker is running before spawning
- `spawnScrutinyValidator` and `spawnUserTestingValidator` run via `Promise.all` — parallel with each other, but only after all workers complete
- The loop is serial across milestones

**Tests (using mocks for AgentPool and SessionManager):**
- Single milestone with one feature runs worker → validators → accept
- Two milestones process sequentially
- Validator failure triggers negotiation → rescope → re-run
- Both validators passing advances milestone
- Worker spawn rejects if another worker is active
- Empty milestone (no features) is skipped

---

### Task 8: Worker agent adapter

**Files to create:**
- `src/missions/worker-agent.ts`
- `tests/missions/worker-agent.test.ts`

**Replace:** The `runMainAgent` function's per-ticket logic. The old function stays for backward compatibility.

The worker is the ephemeral agent that does the actual coding. It replaces the current pattern of spawning a `sub` agent type via AgentPool with environment variables.

```typescript
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

export async function runWorker(config: WorkerConfig): Promise<WorkerResult> {
  // 1. Read feature spec from features.json
  const sharedState = new SharedState(config.sharedStateDir);
  const features = sharedState.readFeatures();
  const feature = features.features.find(f => f.id === config.featureId);

  // 2. Read latest handoff for context
  const latestHandoff = sharedState.readLatestHandoff();

  // 3. Read the worker skill prompt
  const skillLoader = new SkillLoader(sharedState);
  const prompt = skillLoader.loadSkill('worker-implement');

  // 4. Create git branch for feature
  createTicketBranch(config.workspacePath, config.featureId, config.sessionId);

  // 5. Spawn the actual agent process (delegation primitive)
  // This is the pi subprocess or equivalent
  // The agent receives the prompt + feature spec + previous handoff

  // 6. Wait for completion
  // Agent commits to git and exits

  // 7. Build and append handoff entry
  const handoff: HandoffEntry = {
    timestamp: new Date().toISOString(),
    feature_id: config.featureId,
    milestone_index: config.milestoneIndex,
    worker_id: `worker-${config.featureId}-${Date.now()}`,
    what_was_implemented: '...', // extracted from agent output
    what_remains: '...',
    errors_encountered: [],
    commands_run: [],
    exit_codes: {},
    git_commit_hash: '...', // from git rev-parse HEAD
  };

  sharedState.appendHandoff(handoff);

  return { feature_id: config.featureId, success: true, handoff };
}
```

**Key difference from current code:** The worker reads its spec from `features.json` (not from env vars), writes its output to `handoffs.jsonl` (not just exits), and is spawned as a truly ephemeral process.

**Creator-Verifier enforcement:** The worker instance that implements a feature is never the same instance that validates it. Workers and validators are separate code paths, separate agent types, and cannot share a context window.

**Tests:**
- Worker reads correct feature spec
- Worker creates git branch
- Worker appends handoff on completion
- Worker with previous handoff reads it for context
- Worker failure still appends handoff with errors

---

### Task 9: Rewrite `Orchestrator` class to use missions

**Files to modify:**
- `src/orchestrator.ts` — major rewrite

**Replace:** The current `Orchestrator` class is replaced with one that delegates to `MilestoneLoop`.

The new `Orchestrator` is much thinner. It:
1. Creates a session (unchanged)
2. Initializes shared state for the mission
3. Runs the milestone loop
4. Exposes the same public API for the HTTP/WS layer

```typescript
export class Orchestrator {
  public readonly db: Database;
  public readonly sessionManager: SessionManager;
  public readonly agentPool: AgentPool;
  public readonly boardEvents: BoardEvents;

  private missions: Map<string, SharedState> = new Map();
  private loops: Map<string, MilestoneLoop> = new Map();

  constructor(private config: OrchestratorConfig) {
    this.db = new Database(config.dbPath);
    this.sessionManager = new SessionManager(this.db, config.workspaceRoot);
    this.agentPool = new AgentPool();
    this.boardEvents = new BoardEvents();
  }

  startMission(req: StartMissionRequest): { sessionId: string; sharedState: SharedState } {
    // Create session
    const session = this.sessionManager.create(req.repoUrl);

    // Initialize shared state directory
    const missionDir = path.join(session.repo_path, '.aelvyril', 'missions', session.id);
    const sharedState = new SharedState(missionDir);

    // Build features.json from the goal (could call planning model here)
    const features = this.decomposeGoal(req.goal, req.context);
    const models = this.resolveModels();

    sharedState.initialize(features, models);
    this.missions.set(session.id, sharedState);

    // Create milestone loop
    const loop = new MilestoneLoop(
      sharedState,
      this.agentPool,
      this.sessionManager,
      this.boardEvents,
    );
    this.loops.set(session.id, loop);

    return { sessionId: session.id, sharedState };
  }

  async executeMission(sessionId: string): Promise<MissionResult> {
    const loop = this.loops.get(sessionId);
    if (!loop) throw new Error(`No mission for session ${sessionId}`);
    return loop.run();
  }

  // Legacy support — routes to old startSession for non-mission workflows
  startSession(repoUrl: string): { sessionId: string; board: BoardManager } {
    // ... existing implementation unchanged
  }

  destroySession(sessionId: string): void {
    this.loops.delete(sessionId);
    this.missions.delete(sessionId);
    // ... existing cleanup
  }

  private decomposeGoal(goal: string, context?: string): FeaturesFile {
    // For now: call the planning model via the orchestrator skill
    // Returns a FeaturesFile with milestones and features
    // This is where the orchestrator-plan.md skill is used
  }

  private resolveModels(): ModelAssignment {
    // Load from config or use defaults
    // This is where model-assignment.json is consulted
  }
}
```

**Migration strategy:** Both `startSession` (legacy) and `startMission` (new) coexist. The WS handler routes to the appropriate one based on the message type. Legacy sessions continue to work exactly as before. No breaking changes.

**Tests:**
- `startMission` creates session, shared state, and loop
- `executeMission` delegates to milestone loop
- Legacy `startSession` still works
- `destroySession` cleans up both mission and legacy state

---

### Task 10: Research subagent tier

**Files to create:**
- `src/missions/research-subagent.ts`
- `tests/missions/research-subagent.test.ts`

**Replace:** Nothing — new.

Research subagents run in parallel with the milestone loop. They are read-only — they never modify the codebase. They write findings to `research-findings/` in shared state.

```typescript
export interface ResearchConfig {
  sessionId: string;
  sharedStateDir: string;
  query: string;
  scope: 'codebase' | 'docs' | 'web';
}

export async function runResearchSubagent(config: ResearchConfig): Promise<void> {
  const sharedState = new SharedState(config.sharedStateDir);
  const skillLoader = new SkillLoader(sharedState);
  const prompt = skillLoader.loadSkill('research-subagent');

  // Spawn read-only agent
  // Agent explores codebase, docs, or web (no write tools)
  // Agent writes finding to sharedState.writeResearchFinding(id, content)
}
```

**Concurrency:** Multiple research subagents can run simultaneously since they are read-only and write to separate files in `research-findings/`.

**Spawning:** The orchestrator can spawn these at any point — during planning, between milestones, or in parallel with validators. Workers and the orchestrator consume findings by reading `research-findings/`.

**Tests:**
- Research subagent writes a finding
- Multiple research subagents can run in parallel
- Research subagent cannot modify codebase (enforced by skill prompt + tool restriction)

---

### Task 11: Negotiation engine

**Files to create:**
- `src/missions/negotiation.ts`
- `tests/missions/negotiation.test.ts`

**Replace:** The implicit retry logic in `runTests`/`runReview` in the current orchestrator.

```typescript
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

export function negotiate(
  scrutiny: ValidationVerdict,
  userTesting: ValidationVerdict,
  milestone: Milestone,
  handoffs: HandoffEntry[],
  errorLog: ErrorEntry[],
  maxRetries: number = 2,
): NegotiationVerdict {
  // Both pass → accept
  if (scrutiny.passed && userTesting.passed) {
    return { action: 'accept', reason: 'All validations passed' };
  }

  // Count retries for this milestone from handoffs
  const milestoneHandoffs = handoffs.filter(h => h.milestone_index === milestone.index);
  const retryCount = milestoneHandoffs.length - milestone.features.length; // subtract first attempt

  if (retryCount >= maxRetries) {
    return { action: 'block', reason: `Max retries (${maxRetries}) exceeded for milestone ${milestone.name}` };
  }

  // Determine which features failed
  const failedFeatures = new Set([
    ...scrutiny.failed_features,
    ...userTesting.failed_features,
  ]);

  // Rescope: retry only failed features
  return {
    action: 'rescope',
    reason: `Validation failures in: ${[...failedFeatures].join(', ')}`,
    rescope_changes: {
      features_to_retry: [...failedFeatures],
      features_to_drop: [],
      features_to_add: [],
    },
  };
}
```

**This is the only place re-scoping happens.** The orchestrator's negotiation step is the single decision point for retry/rescope/block. No other agent can modify the plan.

**Tests:**
- Both pass → accept
- One fails → rescope with failed features
- Max retries exceeded → block
- Empty milestone → accept
- Both fail → rescope with all features
- Rescope after partial pass only retries failed features

---

### Task 12: WS/HTTP route updates

**Files to modify:**
- `src/routes/ws-handler.ts`
- `src/routes/session-routes.ts`

**Replace:** Add new routes for mission-based sessions. Keep existing routes.

New WS message types:
```typescript
{ type: 'start_mission', goal: string, repo_url: string, context?: string }
{ type: 'mission_status', session_id: string }
{ type: 'mission_handoffs', session_id: string }
{ type: 'mission_negotiate', session_id: string, action: 'accept' | 'rescope' | 'block' }
{ type: 'spawn_research', session_id: string, query: string, scope: string }
```

New HTTP endpoints:
```
POST /api/missions              → startMission
GET  /api/missions/:id/status   → mission status + current milestone
GET  /api/missions/:id/handoffs → full handoff log
GET  /api/missions/:id/features → current features.json
POST /api/missions/:id/research → spawn research subagent
```

**Tests:**
- WS start_mission creates a mission session
- WS mission_status returns current state
- HTTP endpoints return correct data
- Legacy session routes still work

---

### Task 13: Broadcast system

**Files to create:**
- `src/missions/broadcast.ts`
- `tests/missions/broadcast.test.ts`

**Replace:** The `boardEvents.emit` pattern. Not a direct replacement — broadcasts are file-based, not event-emitter-based.

```typescript
export class BroadcastManager {
  constructor(private sharedState: SharedState) {}

  publish(from: string, type: BroadcastEntry['type'], message: string): void {
    this.sharedState.appendBroadcast({ timestamp: new Date().toISOString(), from, type, message });
  }

  readSince(index: number): BroadcastEntry[] {
    return this.sharedState.readBroadcasts(index);
  }
}
```

Every agent reads broadcasts before acting. The orchestrator publishes status updates after each milestone step. Workers publish when they start and finish. Validators publish their verdicts.

**Tests:**
- Publish and read works
- Read since index returns only new entries
- Multiple agents can publish without conflicts

---

### Task 14: Integration test — full mission lifecycle

**Files to create:**
- `tests/integration/mission-lifecycle.test.ts`

A single integration test that exercises the full loop:

1. `startMission` with a goal
2. Shared state initialized with features + milestones
3. Milestone loop runs:
   - Validation contract written
   - Worker spawned for feature #1, completes, handoff appended
   - Worker spawned for feature #2, completes, handoff appended
   - Scrutiny validator runs (mocked to pass)
   - User testing validator runs (mocked to pass)
   - Negotiation accepts
4. Next milestone runs
5. Mission completes

And a failure path:
1. Same setup
2. Worker completes
3. Scrutiny validator fails
4. Negotiation rescopes
5. Re-run milestone with just failed features
6. Passes on retry
7. Mission completes

---

## Execution order

Tasks have dependencies. Implement in this order:

```
Task 1  (shared state)           ← no deps, foundational
Task 2  (skill loader)           ← depends on Task 1
Task 3  (handoff log)            ← no deps, foundational
Task 4  (types)                  ← no deps, foundational
Task 5  (validation contract)    ← depends on Task 1
Task 6  (model assignment)       ← depends on Task 1
Task 7  (milestone loop)         ← depends on Tasks 1, 3, 4, 5, 6
Task 8  (worker agent)           ← depends on Tasks 1, 2, 3, 4
Task 9  (orchestrator rewrite)   ← depends on Tasks 7, 8
Task 10 (research subagent)      ← depends on Tasks 1, 2
Task 11 (negotiation engine)     ← depends on Tasks 3, 5
Task 12 (routes)                 ← depends on Task 9
Task 13 (broadcast system)       ← depends on Task 1
Task 14 (integration test)       ← depends on all above
```

**Parallelizable tracks:**
- Track A (state layer): Tasks 1 → 2 → 5 → 6
- Track B (log layer): Tasks 3 → 11
- Track C (types): Task 4
- Track D (agents): Tasks 8 → 10
- Track E (loop): Task 7 (after A + B + C)
- Track F (integration): Tasks 9 → 12 → 13 → 14

Tasks 1, 3, and 4 can start simultaneously.

---

## Serial constraint enforcement

The serial constraint (one worker at a time) is enforced at three levels:

1. **MilestoneLoop.spawnWorker** — checks `this.currentWorker === null` before spawning, throws if not
2. **AgentPool** — add a `acquireWorkerSlot()`/`releaseWorkerSlot()` guard that rejects double-acquisition
3. **Skill prompt** — the `worker-implement.md` skill explicitly states the worker is the only active code-modifying agent

The file-system-based shared state naturally serializes access since workers write to different git branches and handoff entries include commit hashes.

---

## What gets deleted eventually

After all tasks are complete and the mission system is stable:

- `src/agents/main-agent/main-agent.ts` → replaced by `worker-agent.ts` + `milestone-loop.ts`
- `src/agents/main-agent/wave-executor.ts` → replaced by serial milestone execution
- The `watchdog` system → replaced by the negotiation engine (the orchestrator monitors instead)
- `src/supervisor/supervisor-agent.ts` → `classifyIntent` still useful for chat routing, but the supervisor as a long-running agent goes away

**Do not delete these yet.** Keep them for backward compatibility until the mission system is proven. Both code paths coexist behind the `startSession` vs `startMission` split in the Orchestrator.
