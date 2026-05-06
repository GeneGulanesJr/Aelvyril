import type { Ticket } from '../../types/common.js';
import type { DiffResult } from './diff-collector.js';

export function buildReviewPrompt(
  ticket: Ticket,
  diff: DiffResult,
  memoryContext: string[]
): string {
  const contextBlock = memoryContext.length > 0
    ? `\n## Codebase Conventions (from memory)\n${memoryContext.map(m => `- ${m}`).join('\n')}\n`
    : '';

  const retryBlock = ticket.reject_count > 0
    ? `\n## ⚠ This is re-review #${ticket.reject_count}\nPrevious feedback: "${ticket.review_notes}"\nAddress the issues from the previous review.\n`
    : '';

  return `You are a Review Agent for Aelvyril. Review the code changes for this ticket.

## Ticket #${ticket.id}: ${ticket.title}
${ticket.description}

## Acceptance Criteria
${ticket.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## Changed Files
${diff.files.map(f => `- ${f}`).join('\n')}

## Diff Stats
${diff.stats.additions} additions, ${diff.stats.deletions} deletions

## Full Diff
\`\`\`diff
${diff.diff}
\`\`\`
${retryBlock}${contextBlock}
## Review Checklist
1. Does the code meet ALL acceptance criteria?
2. Are there any regressions or side effects?
3. Is error handling sufficient?
4. Are there edge cases not covered?
5. Does the code follow codebase conventions?
6. Are there any performance concerns?
7. Is the code readable and maintainable?

## Your Output
Respond with a single JSON object:
\`\`\`json
{
  "approved": true/false,
  "summary": "Brief summary of the review",
  "notes": "Detailed feedback for the developer",
  "issues": [
    {
      "file": "src/Toggle.tsx",
      "line": 42,
      "severity": "critical|warning|suggestion",
      "message": "Description of the issue"
    }
  ]
}
\`\`\`

If approving: all acceptance criteria must be met, no critical issues.
If rejecting: provide specific, actionable feedback. Never reject with vague feedback like "needs improvement".`;
}
