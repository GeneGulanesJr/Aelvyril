import type { StuckTicket } from './stuck-detector.js';

export type InterventionAction = 'retry' | 're_scope' | 'escalate' | 'break_deadlock' | 'hold' | 'wait';

export interface InterventionDecision {
  action: InterventionAction;
  reasoning: string;
  parameters: Record<string, unknown>;
}

export function buildInterventionPrompt(
  stuckTicket: StuckTicket,
  ticketTitle: string,
  boardContext: string[],
  rejectCount?: number,
  lastReviewNotes?: string
): string {
  const rejectBlock = rejectCount && rejectCount > 0
    ? `\n## Reject History\nThis ticket has been rejected ${rejectCount} times.\nLast feedback: "${lastReviewNotes}"\n`
    : '';

  const contextBlock = boardContext.length > 0
    ? `\n## Board Context\n${boardContext.map(c => `- ${c}`).join('\n')}\n`
    : '';

  return `You are the Watchdog intervention system for Aelvyril. A ticket appears stuck.

## Stuck Ticket #${stuckTicket.ticket_id}: ${ticketTitle}
- Status: ${stuckTicket.status}
- Stuck for: ${stuckTicket.minutes_stuck} minutes
- Reason detected: ${stuckTicket.reason}
- Suggested action: ${stuckTicket.recommended_action}
${rejectBlock}${contextBlock}
## Available Actions
Pick ONE action:
1. **retry** — Kill the current agent process, re-dispatch the ticket to a new agent (same branch)
2. **re_scope** — The ticket scope is wrong. Provide a new description for the Ticket Agent to re-plan.
3. **escalate** — Escalate to the user. This needs human input.
4. **break_deadlock** — There's a dependency deadlock. Break it by removing the weakest dependency.
5. **hold** — Pause the ticket (e.g., API is down). Provide a reason.
6. **wait** — The situation may resolve itself. No action now, check again later.

## Your Output
Respond with a single JSON object:
\`\`\`json
{
  "action": "retry|re_scope|escalate|break_deadlock|hold|wait",
  "reasoning": "Why you chose this action",
  "parameters": {}
}
\`\`\`

For re_scope, include: { "parameters": { "new_description": "..." } }
For hold, include: { "parameters": { "reason": "..." } }
For retry, include: { "parameters": { "max_retries": 1 } }`;
}

export function parseInterventionResponse(raw: string): InterventionDecision {
  const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ?? [null, raw];
  const jsonStr = jsonMatch[1] || raw;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr.trim());
  } catch {
    return { action: 'wait', reasoning: 'Could not parse intervention response', parameters: {} };
  }

  return {
    action: (parsed.action as InterventionAction) ?? 'wait',
    reasoning: (parsed.reasoning as string) ?? '',
    parameters: (parsed.parameters as Record<string, unknown>) ?? {},
  };
}
