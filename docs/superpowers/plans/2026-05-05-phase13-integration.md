# Phase 13: Integration — Full Pipeline E2E, Git Strategy, Cost, Audit

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up all 7 agents into a complete working pipeline. End-to-end test: user says "Add dark mode" → Supervisor → Ticket Agent → board → Main Agent → Sub-agents → Test Agent → Review Agent → Watchdog monitoring → auto PR → auto merge. Verify crash recovery works. Verify cost tracking across the full pipeline. Verify audit log captures everything.

**Architecture:** Integration tests that spin up the full Orchestrator with mock pi processes (or real pi if available). Tests the complete flow from user request through the pipeline to git PR creation. Also tests error scenarios (test failure, review rejection, LLM API failure, crash recovery).

**Tech Stack:** Integration tests, mock/spawn pi processes, real git operations

**Spec reference:** Full spec `docs/superpowers/specs/2026-05-05-cloud-platform-design.md`

**Depends on:** Phase 1-12

---

## File Structure

```
tests/
└── integration/
    ├── full-pipeline.test.ts     # E2E: request → tickets → sub-agents → test → review → PR
    ├── crash-recovery.test.ts    # Kill orchestrator mid-task, restart, verify recovery
    ├── cost-tracking.test.ts     # Verify cumulative cost across full pipeline
    └── error-scenarios.test.ts   # Test fail, reject, held state, reject threshold escalation
```

### Task 1: Pipeline orchestrator glue code
- [ ] Wire SessionManager + AgentPool + BoardManager + all agents into the Orchestrator server → commit

### Task 2: Full pipeline E2E test
- [ ] Write E2E test: user request → tickets → dispatch → complete → test → review → PR → commit

### Task 3: Crash recovery test
- [ ] Write test: kill mid-pipeline → restart → Watchdog re-dispatches → pipeline completes → commit

### Task 4: Error scenario tests
- [ ] Test: sub-agent test failure → back to In Progress → commit
- [ ] Test: review rejection → back to Backlog with notes → commit
- [ ] Test: LLM API failure → Held state → user resolves → resume → commit
- [ ] Test: 3x reject → escalate to user → commit

### Task 5: Cost tracking verification
- [ ] Write test: full pipeline → verify CostReport matches actual agent usage → commit

### Task 6: REST API endpoints
- [ ] Add HTTP endpoints: GET /sessions, GET /sessions/:id/board, GET /sessions/:id/cost, GET/PUT /config → commit

### Task 7: Serve static UI files
- [ ] Configure server.ts to serve built React UI from ui/dist/ → commit

### Task 8: Run full integration suite
- [ ] Run: `npx vitest run` → ALL PASS → final commit
