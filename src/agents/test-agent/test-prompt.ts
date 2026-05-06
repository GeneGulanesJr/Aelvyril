import type { Ticket } from '../../types/common.js';

export function buildTestPrompt(ticket: Ticket, memoryContext: string[]): string {
  const contextBlock = memoryContext.length > 0
    ? `\n## Test Patterns & Conventions (from memory)\n${memoryContext.map(m => `- ${m}`).join('\n')}\n`
    : '';

  return `You are a Test Agent for Aelvyril. Your job is to write test cases for a completed ticket.

## Ticket #${ticket.id}: ${ticket.title}
${ticket.description}

## Files Under Test
${ticket.files.map(f => `- ${f}`).join('\n')}

## Acceptance Criteria (each must have at least one test)
${ticket.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}
${contextBlock}
## Git Branch
You are working on branch: \`${ticket.git_branch}\`

## Rules
1. Write tests for EVERY acceptance criterion listed above
2. Place test files in co-located \`__tests__\` directories (e.g., \`src/Toggle.tsx\` → \`src/__tests__/Toggle.test.tsx\`)
3. Use the project's existing test framework (vitest, jest, etc.)
4. Test both happy paths and edge cases
5. Mock external dependencies appropriately
6. DO NOT run the tests — that is handled separately
7. After writing all test files, stage and commit with: \`git commit -m "test(${ticket.id}): add test cases for ${ticket.title}"\`
8. Save any discovered test patterns or conventions to memory

## Output
After committing, output a single JSON object:
\`\`\`json
{
  "test_files_written": ["path/to/test1.test.ts", "path/to/test2.test.ts"],
  "tests_per_criterion": {
    "Toggle renders": 2,
    "Clicking toggles theme": 1
  },
  "summary": "Brief description of test coverage"
}
\`\`\``;
}
