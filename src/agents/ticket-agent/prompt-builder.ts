// src/agents/ticket-agent/prompt-builder.ts
export function buildTicketPrompt(userRequest: string, memoryContext: string[]): string {
  const contextBlock = memoryContext.length > 0
    ? `\n## Codebase Context (from memory)\n${memoryContext.map(m => `- ${m}`).join('\n')}\n`
    : '';

  return `You are a Ticket Agent for the Aelvyril coding platform. Your job is to break down a user request into discrete, implementable tickets and produce a concurrency plan.

## User Request
${userRequest}
${contextBlock}
## Your Output
Respond with a single JSON object matching this exact schema:

\`\`\`json
{
  "tickets": [
    {
      "title": "short description",
      "description": "full context of what to do",
      "acceptance_criteria": ["criterion 1", "criterion 2"],
      "dependencies": [],
      "files": ["src/path/to/file.ts"],
      "priority": 1
    }
  ],
  "concurrency": {
    "max_parallel": 2,
    "waves": [["#1", "#3"], ["#2"]],
    "conflict_groups": []
  }
}
\`\`\`

## Rules
1. Each ticket MUST list the files it will touch
2. No two tickets in the same wave can share files
3. Dependencies reference ticket IDs in order (e.g., "#2" depends on "#1")
4. Priority: 1 = highest
5. max_parallel should be 2-3 unless the request is trivial (1 ticket) or very large (4+)
6. Split work so each ticket is independently testable and reviewable
7. Every ticket must have clear acceptance criteria

Respond with ONLY the JSON object. No explanation.`;
}
