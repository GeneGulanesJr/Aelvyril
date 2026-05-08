# Missions v3 — Test & Design Gap Closure Plan

> Completes the missing unit tests, design stubs, and integration coverage identified after the initial 14-task implementation.

---

## Current state

- **212 tests pass**, 38/39 suites (1 pre-existing failure in `git-operations.test.ts`)
- **Zero TypeScript errors** in backend/missions files
- All 14 plan tasks have source implementations
- **7 unit test files** from the plan were never written
- **3 design stubs** return hardcoded values instead of real behavior
- **Integration test** only covers the happy path

---

## Phase A: Missing unit tests (7 files)

### Task A1: Skill loader test

**File:** `tests/missions/skill-loader.test.ts`

Tests:
- Load an existing skill file and return contents
- Variable substitution with `{{key}}` placeholders
- `listSkills()` returns all `.md` files in `agent-skills/`
- Loading a nonexistent skill throws `Skill not found: {name}`
- Loading with no `vars` returns raw content unchanged

### Task A2: Validation contract test

**File:** `tests/missions/validation-contract.test.ts`

Tests:
- `ValidationContractManager.write()` persists contract to shared state
- `read()` returns the written contract
- `lock()` sets `locked: true` and persists
- `isLocked()` reflects lock state
- Writing to a locked contract throws
- Writing after unlock (new milestone) succeeds

### Task A3: Model assignment test

**File:** `tests/missions/model-assignment.test.ts`

Tests:
- `ModelAssignmentManager.load()` reads from shared state
- `load()` returns `DEFAULT_MODEL_ASSIGNMENT` when no file exists
- `update()` merges partial config and persists
- `resolveForAgentType()` returns correct model string for each agent type
- `resolveForAgentType()` with unknown type throws

### Task A4: Worker agent test

**File:** `tests/missions/worker-agent.test.ts`

Tests (mock `AgentPool` and `createTicketBranch`):
- Worker reads feature spec from `features.json`
- Worker creates git branch via `createTicketBranch`
- Worker spawns ephemeral agent via `pool.spawnEphemeral`
- Worker appends handoff on completion
- Worker with missing feature ID returns `success: false`
- Worker reads latest handoff for context when available

### Task A5: Research subagent test

**File:** `tests/missions/research-subagent.test.ts`

Tests (mock `AgentPool`):
- Research subagent spawns ephemeral agent with correct env vars
- Research subagent writes finding to `research-findings/`
- Returns a finding ID
- Uses skill prompt when available, falls back to inline when not

### Task A6: Milestone loop test

**File:** `tests/missions/milestone-loop.test.ts`

Tests (mock `AgentPool`, `SessionManager`, `BoardEvents`):
- Single milestone with one feature: worker runs → validators pass → accept → advance
- Two milestones process sequentially
- Validator failure triggers negotiation → rescope → re-run same milestone
- Both validators passing advances milestone
- Worker spawn rejects if worker lock is occupied
- Empty milestone (no pending features) is skipped
- Blocked verdict stops the loop
- `MissionResult` has correct counts and status

### Task A7: Broadcast test

**File:** `tests/missions/broadcast.test.ts`

Tests:
- `publish()` appends a broadcast entry to `broadcasts.jsonl`
- `readSince(0)` returns all entries
- `readSince(n)` returns only entries after index `n`
- Multiple agents can publish without conflicts (sequential appends)

---

## Phase B: Design stub implementations (3 fixes)

### Task B1: Real `spawnScrutinyValidator`

**File:** `src/missions/milestone-loop.ts` — replace `spawnScrutinyValidator` stub

Current: returns hardcoded `{ passed: true }`.

Target:
1. Read the validation contract from shared state
2. Load the `scrutiny-validator.md` skill prompt
3. Spawn an ephemeral `scrutiny_validator` agent via `AgentPool.spawnEphemeral`
4. The agent receives the contract as its prompt
5. Wait for the agent process to complete (or timeout)
6. Parse the agent's stdout to extract a `ValidationVerdict`
7. If parsing fails or agent crashes, return `{ passed: false, ... }` with error details

Also needs: a `waitForAgent(agentId: string, timeoutMs?: number): Promise<AgentResult>` utility that polls `AgentProcess.getStatus()` until the process exits or times out. This utility is also needed by Task B2 and B3.

### Task B2: Real `spawnUserTestingValidator`

**File:** `src/missions/milestone-loop.ts` — replace `spawnUserTestingValidator` stub

Same pattern as B1 but:
1. Loads `user-testing-validator.md` skill prompt
2. Spawns `user_testing_validator` agent type
3. Agent receives the functional flows from the validation contract

### Task B3: Real `runWorker` with process completion wait

**File:** `src/missions/worker-agent.ts`

Current: calls `pool.spawnEphemeral()` (fire-and-forget) and immediately writes the handoff.

Target:
1. Spawn the worker process
2. Call `waitForAgent(agentId, timeoutMs)` to wait for completion
3. Read the agent's exit code from `AgentProcess.getStatus()`
4. If the agent failed, read stderr and include in handoff errors
5. Only write handoff after the agent actually finishes
6. Capture the real git commit hash (currently works, but only if the agent had time to commit)

This is the highest-priority design fix since the current code writes handoffs before the worker finishes.

---

## Phase C: Integration test gaps

### Task C1: Integration test — rescope/retry failure path

**File:** `tests/integration/mission-lifecycle.test.ts` — add tests

Tests to add:
- Start mission → manually set features to fail → run milestone loop with mocked validators that return `passed: false` → verify negotiation returns `rescope` → verify feature status reset to `pending` → verify milestone does NOT advance
- Start mission → force `retry_count` above max → verify negotiation returns `block` → verify `MissionResult.status === 'blocked'`
- Start mission → run milestone loop with passing validators → verify `MissionResult.status === 'done'` and correct milestone/feature counts

These require mocking `MilestoneLoop` internals (validators) since the full loop is not easily testable end-to-end without real agent processes. Alternative: test the loop directly by constructing it with mocked `AgentPool`, `SessionManager`, and overriding validator methods.

### Task C2: Integration test — HTTP/WS mission routes

**File:** `tests/integration/mission-routes.test.ts` (new file)

Tests:
- `POST /api/missions` with `{ goal, repo_url }` → 200, returns `{ session_id, mission_id }`
- `GET /api/missions/:id/status` → returns features + current milestone
- `GET /api/missions/:id/handoffs` → returns empty array initially
- `GET /api/missions/:id/features` → returns full features.json
- `POST /api/missions/:id/research` with `{ query, scope }` → spawns research, returns finding ID
- `GET /api/sessions` still works (legacy not broken)
- `GET /api/config` still works (legacy not broken)

These require spinning up an HTTP server with the orchestrator (same pattern as `api-endpoints.test.ts`).

---

## Phase D: Pre-existing fix (optional)

### Task D1: Fix `git-operations.test.ts` mock hoisting

**File:** `tests/agents/main-agent/git-operations.test.ts`

The test uses `vi.mock('child_process', ...)` with a factory that references `realExecSync` declared outside the factory. Vitest hoists `vi.mock` calls above all other statements, so `realExecSync` is in a TDZ when the factory runs.

Fix: Move the real `execSync` capture inside the factory using `vi.importActual`:

```typescript
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    execSync: vi.fn((cmd: string, opts?: any) => actual.execSync(cmd, opts)),
  };
});
```

---

## Execution order

```
Phase A (tests — no interdependencies):
  A1, A2, A3, A4, A5, A6, A7 — all can run in parallel
  except A6 depends on A4, A5 (milestone loop needs worker + research)

Phase B (design fixes — sequential):
  B3 (worker wait) ← highest priority, unblocks correct behavior
  B1 (scrutiny validator)
  B2 (user testing validator)

Phase C (integration — depends on Phase B):
  C1 ← depends on B1, B2, B3 for realistic loop behavior
  C2 ← independent, can run in parallel with B

Phase D (optional):
  D1 ← independent
```

**Recommended order:** A1–A5, A7 (parallel) → B3 → A6 → B1, B2 (parallel) → C1, C2 (parallel) → D1

---

## Summary

| Phase | Tasks | New test files | New/modified source files |
|-------|-------|----------------|--------------------------|
| A     | 7     | 7              | 0                        |
| B     | 3     | 0              | 2 (milestone-loop.ts, worker-agent.ts) |
| C     | 2     | 1 + extend 1   | 0                        |
| D     | 1     | 0              | 0 (fix existing test)    |
| Total | 13    | 8 new          | 2 modified               |

Expected new test count: ~50–60 additional tests across all phases.
