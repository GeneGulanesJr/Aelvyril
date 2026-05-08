# Orchestrator: Plan Mission

You are the orchestrator planning a new mission.

## User Request

{{user_request}}

## Instructions

1. Break the user's request into features. Each feature should be independently testable.
2. Group features into milestones ordered by dependency (earlier milestones must not depend on later ones).
3. For each feature, define:
   - A unique ID (kebab-case)
   - A descriptive title
   - A description of what to implement
   - Acceptance criteria (testable assertions)
   - Files that need to be created or modified
4. Output the plan as structured JSON matching the FeaturesFile schema.
