# Missions v3 — Test & Design Gap Closure Plan

> Completes the missing unit tests, design stubs, and integration coverage identified after the initial 14-task implementation.
> Reviewed and corrected against actual codebase signatures on 2026-05-08.

---

## Current state

- **212 tests pass**, 38/39 suites (1 pre-existing failure in `git-operations.test.ts`)
- **Zero TypeScript errors** in backend/missions files
- All 14 plan tasks have source implementations
- **7 unit test files** from the plan were never written
- **3 design stubs** return hardcoded values instead of real behavior
- **Integration test** only covers the happy path

---

## Prerequisite: Bug fixes already applied

These bugs were found during plan review and are already fixed:

1. **`tests/integration/mission-lifecycle.test.ts`** — used `source` instead of `from` on `BroadcastEntry`, and `type: 'progress'` which isn't a valid value. Fixed to use `from` and `type: 'context'`.
2. **`src/missions/shared-state.ts` `advanceMilestone()`** — did not clear the validation contract file when advancing milestones. This meant writing a new contract after `advanceMilestone()` would throw because the old locked contract still existed. Fixed by adding `clearValidationContract()` call at the end of `advanceMilestone()`.

---

## Phase A: Missing unit tests (7 files)

### Task A1: Skill loader test

**File:** `tests/missions/skill-loader.test.ts`

**Actual signatures to test** (`src/missions/skill-loader.ts`):
```typescript
class SkillLoader {
  constructor(private sharedState: SharedState) {}
  loadSkill(name: string, vars?: Record<string, string>): string
  listSkills(): string[]
}
```

Tests:
- Load an existing skill file and return contents
- Variable substitution with `{{key}}` placeholders (second arg to `loadSkill`)
- `listSkills()` returns all `.md` filenames (without extension) from `agent-skills/` directory
- Loading a nonexistent skill throws `Skill not found: {name}`
- Loading with no `vars` returns raw content unchanged (no substitution)

### Task A2: Validation contract test

**File:** `tests/missions/validation-contract.test.ts`

**Actual signatures** (`src/missions/validation-contract.ts`):
```typescript
class ValidationContractManager {
  constructor(private sharedState: SharedState) {}
  write(contract: ValidationContract): void
  read(): ValidationContract | null
  lock(): void
  isLocked(): boolean
}
```

Note: `ValidationContract` is an object type defined in `missions.types.ts:91-107`, not a string.

Tests:
- `write()` persists a `ValidationContract` object to shared state
- `read()` returns the written contract with correct shape
- `lock()` sets `locked: true` and persists
- `isLocked()` reflects lock state
- Writing to a locked contract throws (delegates to `sharedState.writeValidationContract` which checks)
- Writing a new contract after `advanceMilestone()` clears the old one (uses `sharedState.clearValidationContract()`)

### Task A3: Model assignment test

**File:** `tests/missions/model-assignment.test.ts`

**Actual signatures** (`src/missions/model-assignment.ts`):
```typescript
class ModelAssignmentManager {
  constructor(private sharedState: SharedState) {}
  load(): ModelAssignment
  update(partial: Partial<ModelAssignment>): void
  resolveForAgentType(agentType: string): string
}
```

Note: `load()` reads from `sharedState.readModelAssignment()` which returns the stored object. The `??` fallback to `DEFAULT_MODEL_ASSIGNMENT` is in the implementation. If `readModelAssignment()` returns `null` (file doesn't exist during `initialize()`), the fallback triggers. Since `initialize()` always writes the model assignment file, `load()` will return the stored value in normal usage.

Tests:
- `load()` reads from shared state (after `initialize()`, returns the initialized value)
- `update()` merges partial config and persists
- `resolveForAgentType()` returns correct model for: `orchestrator`, `worker`, `scrutiny_validator`, `user_testing_validator`, `research_subagent`
- `resolveForAgentType()` with unknown type throws `Unknown agent type: {type}`

### Task A4: Worker agent test

**File:** `tests/missions/worker-agent.test.ts`

**Actual signature** (`src/missions/worker-agent.ts`):
```typescript
function runWorker(config: WorkerConfig, pool: AgentPool): Promise<WorkerResult>
```

Note: Takes **2 parameters** — `config` and `pool`. The plan originally showed 1 parameter.

**Known limitation**: The worker currently fire-and-forgets the spawned process (Task B3 will fix this). Tests should account for:
- Handoff is written immediately (not after agent completion)
- `git_commit_hash` is captured from `git rev-parse HEAD` at call time, not after the agent commits
- Feature status is set to `'done'` immediately

Tests (mock `AgentPool` with a no-op `spawnEphemeral`, mock `createTicketBranch`):
- Worker reads feature spec from `features.json` via `SharedState`
- Worker calls `createTicketBranch(config.workspacePath, config.featureId, config.sessionId)`
- Worker spawns ephemeral agent via `pool.spawnEphemeral(agentId, sessionId, memoryDbPath, 'worker', env)` with `AELVYRIL_TICKET_PROMPT` env var
- Worker appends handoff to shared state
- Worker returns `{ feature_id, success: true, handoff }` with handoff data
- Worker with missing feature ID returns `{ feature_id, success: false, handoff: null }`
- Worker reads latest handoff for context when available (used in skill prompt `previous_handoff` var)

### Task A5: Research subagent test

**File:** `tests/missions/research-subagent.test.ts`

**Actual signature** (`src/missions/research-subagent.ts`):
```typescript
function runResearchSubagent(config: ResearchConfig, pool: AgentPool): Promise<string>
```

Note: Takes **2 parameters** and returns **`string`** (finding ID), not `void` as originally planned.

Tests (mock `AgentPool` with a no-op `spawnEphemeral`):
- Research subagent spawns ephemeral agent with `agentType: 'research_subagent'` and env vars `AELVYRIL_RESEARCH_QUERY`, `AELVYRIL_RESEARCH_SCOPE`, `AELVYRIL_MISSION_DIR`
- Research subagent writes a finding file to `research-findings/` in shared state
- Returns a finding ID string (format: `finding-{timestamp}-{hex}`)
- Uses skill prompt when `research-subagent.md` exists in `agent-skills/`, falls back to inline prompt when not

### Task A6: Milestone loop test

**File:** `tests/missions/milestone-loop.test.ts`

**Actual class** (`src/missions/milestone-loop.ts`):
```typescript
class MilestoneLoop {
  constructor(
    private sharedState: SharedState,
    private agentPool: AgentPool,
    private sessionManager: SessionManager,
    private boardEvents: BoardEvents,
  ) {}
  async run(): Promise<MissionResult>
  // Private methods: buildValidationContract, spawnScrutinyValidator,
  // spawnUserTestingValidator, findSession
}
```

**Key constraint**: `spawnScrutinyValidator` and `spawnUserTestingValidator` are **private** methods. They cannot be directly mocked or overridden. Testing the loop requires either:
- **Option A**: Mock `AgentPool` to be a no-op so `runWorker` succeeds, and test the loop behavior via `run()` return value and shared state side effects. The validators currently return hardcoded `passed: true` so they'll always pass.
- **Option B**: After Phase B makes validators injectable (see Task B0), mock them directly.

For Phase A, use **Option A** — test with the hardcoded passing validators.

Tests (mock `AgentPool`, `SessionManager`, `BoardEvents`; set up `SharedState` with features):
- Single milestone with one feature: `run()` returns `status: 'done'`, feature marked done, one handoff
- Two milestones process sequentially: both complete, two milestones done
- Worker lock rejection: if `acquireWorkerLock` is already occupied, `run()` throws
- Milestone with all features already `done` is skipped (milestone status `'done'`)
- `MissionResult` has correct `milestones_completed`, `features_completed`, `duration_ms`
- `MissionResult.status` is `'done'` when all milestones done, `'blocked'` when loop breaks

Note: Testing rescope/retry and blocked paths requires either Phase B's real validators or a Phase B0 refactor (see below). These are covered in Phase C.

### Task A7: Broadcast test

**File:** `tests/missions/broadcast.test.ts`

**Actual signatures** (`src/missions/broadcast.ts`):
```typescript
class BroadcastManager {
  constructor(private sharedState: SharedState) {}
  publish(from: string, type: 'status' | 'constraint' | 'context', message: string): void
  readSince(index: number): BroadcastEntry[]
  readAll(): BroadcastEntry[]
}
```

Note: `type` is `'status' | 'constraint' | 'context'` — no `'progress'` value exists.

Tests:
- `publish()` appends a broadcast entry with correct `from`, `type`, `message`, and auto-generated `timestamp`
- `readAll()` returns all entries
- `readSince(0)` returns all entries
- `readSince(n)` returns only entries after index `n`
- Multiple sequential `publish()` calls all appear in `readAll()`

---

## Phase B: Design stub implementations and prerequisite refactor

### Task B0: Make validators injectable (prerequisite for B1, B2)

**File:** `src/missions/milestone-loop.ts`

**Problem**: `spawnScrutinyValidator` and `spawnUserTestingValidator` are `private` methods. They cannot be mocked in tests or replaced with real implementations without modifying the class.

**Fix**: Extract validator spawning into an injectable interface:

```typescript
export interface ValidatorSpawner {
  spawnScrutiny(milestone: Milestone): Promise<ValidationVerdict>;
  spawnUserTesting(milestone: Milestone): Promise<ValidationVerdict>;
}

class DefaultValidatorSpawner implements ValidatorSpawner {
  // Contains the current hardcoded stubs (moved here from MilestoneLoop)
}

class MilestoneLoop {
  constructor(
    private sharedState: SharedState,
    private agentPool: AgentPool,
    private sessionManager: SessionManager,
    private boardEvents: BoardEvents,
    private validators: ValidatorSpawner = new DefaultValidatorSpawner(),
  ) {}
}
```

This allows:
- Tests to inject mock validators (rescope, block, pass on demand)
- B1/B2 to implement real validators in `DefaultValidatorSpawner`
- No breaking change — default parameter preserves existing behavior

### Task B1: Real `spawnScrutinyValidator`

**File:** `src/missions/milestone-loop.ts` (in `DefaultValidatorSpawner`)

Current: returns hardcoded `{ passed: true }`.

Target:
1. Read the validation contract from shared state
2. Load the `scrutiny-validator.md` skill prompt via `SkillLoader`
3. Spawn an ephemeral `scrutiny_validator` agent via `AgentPool.spawnEphemeral`
4. The agent receives the contract as its prompt (passed via `AELVYRIL_TICKET_PROMPT` env var)
5. Wait for the agent process to complete via `waitForAgentProcess()` (see B3)
6. Parse the agent's stdout to extract a `ValidationVerdict`
7. If parsing fails or agent crashes, return `{ passed: false, milestone_index, details: error, failed_features: milestone.features, failures: [] }`

### Task B2: Real `spawnUserTestingValidator`

**File:** `src/missions/milestone-loop.ts` (in `DefaultValidatorSpawner`)

Same pattern as B1 but:
1. Loads `user-testing-validator.md` skill prompt
2. Spawns `user_testing_validator` agent type
3. Agent receives the functional flows from the validation contract

### Task B3: Real `runWorker` with process completion wait

**File:** `src/missions/worker-agent.ts`

Current behavior (`worker-agent.ts:38-66`):
```typescript
pool.spawnEphemeral(agentId, ...);  // fire-and-forget
// Immediately captures git hash and writes handoff
```

Target:
1. Spawn the worker process via `pool.spawnEphemeral()`
2. Call `waitForAgentProcess(pool, agentId, timeoutMs)` to wait for completion
3. Read the agent's exit status — `AgentProcess.isRunning()` returns `false` when done
4. If the agent failed or timed out, include errors in handoff
5. Only write handoff after the agent actually finishes
6. Capture the real git commit hash

**New utility required** — `waitForAgentProcess`:

`AgentProcess` (`src/agents/agent-process.ts`) has:
- `isRunning(): boolean` — returns `this.child !== null && this.child.exitCode === null`
- `onStdout(callback)`, `onStderr(callback)` — callback-based, not promise-based
- `getStatus(): AgentStatus` — returns `{ running, pid, ... }` but no exit code

The utility must:
```typescript
// New file: src/missions/agent-wait.ts
async function waitForAgentProcess(
  pool: AgentPool,
  agentId: string,
  timeoutMs: number = 300_000,
): Promise<{ completed: boolean; timedOut: boolean }>
```

Implementation: poll `pool.get(agentId)?.isRunning()` every 1 second until `false` or timeout. This is a simple polling approach since `AgentProcess` doesn't expose a promise-based completion signal.

**Git commit hash caveat**: `git rev-parse HEAD` captures the current HEAD, not necessarily the agent's commit. If the agent commits on a different branch, the hash will be wrong. The worker should capture the hash from the feature branch. For v1, this is acceptable — v2 should have the agent report its commit hash via stdout.

---

## Phase C: Integration test gaps

### Task C1: Integration test — rescope/retry failure path

**File:** `tests/integration/mission-lifecycle.test.ts` — add tests

**Depends on**: Task B0 (injectable validators)

With the `ValidatorSpawner` interface from B0, tests can inject a mock:

```typescript
const mockValidators: ValidatorSpawner = {
  spawnScrutiny: async () => ({ passed: false, ... }),
  spawnUserTesting: async () => ({ passed: true, ... }),
};
const loop = new MilestoneLoop(sharedState, pool, sm, events, mockValidators);
```

Tests to add:
- Rescope path: validators return `passed: false` → negotiation rescopes → feature status reset to `pending` → milestone does NOT advance → loop re-runs same milestone
- Block path: set `retry_count` above `maxRetries` (default 2) → negotiation returns `block` → `MissionResult.status === 'blocked'`
- Accept path: validators pass → `MissionResult.status === 'done'` and correct milestone/feature counts
- Mixed: first attempt fails, second attempt passes after rescope → mission completes

### Task C2: Integration test — HTTP mission routes

**File:** `tests/integration/mission-routes.test.ts` (new file)

**Actual API routes** in `src/routes/session-routes.ts`:

| Route | Method | Response | Status |
|-------|--------|----------|--------|
| `/api/missions` | POST | `{ session_id, status: 'active' }` | **201** |
| `/api/missions/:id/status` | GET | `{ mission_id, current_milestone, features_total, features_done, milestones_total, milestones_done }` | 200 |
| `/api/missions/:id/handoffs` | GET | `HandoffEntry[]` | 200 |
| `/api/missions/:id/features` | GET | `FeaturesFile` | 200 |

Note: `POST /api/missions/:id/research` does **not exist**. If needed, it must be added as a separate task before testing it.

Tests (same pattern as `tests/integration/api-endpoints.test.ts`):
- `POST /api/missions` with `{ goal, repo_url }` → 201, returns `{ session_id, status: 'active' }`
- `POST /api/missions` with missing `goal` → 400, returns `{ error: 'goal and repo_url required' }`
- `GET /api/missions/:id/status` → returns current milestone info
- `GET /api/missions/:id/handoffs` → returns empty array initially
- `GET /api/missions/:id/features` → returns full `FeaturesFile` with milestones and features
- `GET /api/missions/:id/status` with invalid ID → 404
- `GET /api/sessions` still works (legacy not broken)

---

## Phase D: Pre-existing fix (optional)

### Task D1: Fix `git-operations.test.ts` mock hoisting

**File:** `tests/agents/main-agent/git-operations.test.ts`

**Actual problem**: The test already uses `vi.importActual` (lines 8-12):
```typescript
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  realExecSync = actual.execSync;
  return { ...actual, execSync: vi.fn(actual.execSync) };
});
```

The `realExecSync` variable at line 6 is in a temporal dead zone when the hoisted mock factory runs at line 8-12. The factory assigns to `realExecSync` (line 10), but the variable declaration at line 6 is hoisted while the initialization is not. Since the factory is `async` and uses `await vi.importActual`, the assignment happens after the TDZ would normally resolve — but Vitest's hoisting moves the `vi.mock` call before the `let` declaration.

**Fix**: Eliminate the module-level `let` entirely. Use a different approach:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { execSync: realExecSync } = await vi.hoisted(async () => {
  const cp = await import('child_process');
  return { execSync: cp.execSync };
});

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execSync: vi.fn(actual.execSync) };
});
```

Alternatively, use `vi.hoisted()` to declare the shared state:

```typescript
const realExecSync = vi.hoisted(() => {
  // This runs before vi.mock hoisting
  return null as any as typeof import('child_process').execSync;
});

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  // Assign the real one for test setup use
  return { ...actual, execSync: vi.fn(actual.execSync) };
});
```

The simplest working fix: store the real execSync in a module-level object (objects are initialized before `vi.mock` runs):

```typescript
const _real = { execSync: null as any };

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  _real.execSync = actual.execSync;
  return { ...actual, execSync: vi.fn(actual.execSync) };
});

// Use _real.execSync instead of realExecSync throughout
```

---

## Execution order

```
Phase A (unit tests — minimal interdependencies):
  A1, A2, A3, A5, A7 — fully independent, can run in parallel
  A4 — independent (tests worker-agent.ts directly)
  A6 — depends on A4 pattern (same mocking approach for AgentPool)

Phase B (design fixes — sequential):
  B0 (injectable validators) — prerequisite for B1, B2
  B3 (worker wait) — independent, highest priority
  B1 (scrutiny validator) — depends on B0, B3
  B2 (user testing validator) — depends on B0, B3

Phase C (integration — depends on B):
  C1 — depends on B0 (injectable validators for mocking)
  C2 — independent, can run in parallel with Phase B

Phase D (optional):
  D1 — independent
```

**Recommended order:** A1–A5, A7 (parallel) → B0 + B3 (parallel) → A6 → B1 + B2 (parallel) → C1 + C2 (parallel) → D1

---

## Summary

| Phase | Tasks | New test files | New/modified source files |
|-------|-------|----------------|--------------------------|
| A     | 7     | 7              | 0                        |
| B     | 4     | 0              | 3 (milestone-loop.ts, worker-agent.ts, new agent-wait.ts) |
| C     | 2     | 1 + extend 1   | 0                        |
| D     | 1     | 0              | 0 (fix existing test)    |
| Total | 14    | 8 new          | 3 modified/created       |

Expected new test count: ~50–60 additional tests across all phases.
