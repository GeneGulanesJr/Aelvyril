# Phase 9: Review Agent — Code Review with Approve/Reject

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Review Agent — an ephemeral agent that reviews completed + tested code changes on a ticket branch. Checks code quality, matches acceptance criteria, reviews for regressions. Approves (→ Done) or rejects (→ Backlog with review notes). Reads codebase conventions from PiMemory.

**Architecture:** The Review Agent receives the ticket ID and branch, reads the diff between the ticket branch and session branch, reviews against acceptance criteria and codebase conventions stored in memory. Outputs a structured review decision.

**Tech Stack:** pi, PiMemoryExtension (reads conventions), git diff

**Spec reference:** `docs/superpowers/specs/2026-05-05-cloud-platform-design.md` §3.2, §3.5

**Depends on:** Phase 1-8

---

## File Structure

```
src/
├── agents/
│   ├── review-agent/
│   │   ├── review-agent.ts       # Spawn review agent, collect decision
│   │   ├── review-prompt.ts      # Build prompt with diff + acceptance criteria
│   │   └── diff-collector.ts     # Get git diff for the ticket branch
tests/
├── agents/
│   └── review-agent/
│       ├── review-prompt.test.ts
│       └── diff-collector.test.ts
```

### Task 1: Diff collector
- [ ] Write failing test → implement → pass → commit

### Task 2: Review prompt builder
- [ ] Write failing test — prompt includes diff, acceptance criteria, conventions → implement → pass → commit

### Task 3: Review decision parser
- [ ] Write failing test — parse approve/reject with notes → implement → pass → commit

### Task 4: Run all Phase 9 tests
- [ ] Run: `npx vitest run` → ALL PASS → commit
