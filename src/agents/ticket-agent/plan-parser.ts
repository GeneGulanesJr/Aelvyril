// src/agents/ticket-agent/plan-parser.ts

interface RawTicket {
  title: string;
  description: string;
  acceptance_criteria: string[];
  dependencies: string[];
  files: string[];
  priority: number;
}

interface RawConcurrency {
  max_parallel: number;
  waves: string[][];
  conflict_groups: string[][];
}

interface RawPlanResponse {
  tickets: RawTicket[];
  concurrency: RawConcurrency;
}

export interface ParsedPlan {
  tickets: RawTicket[];
  plan: RawConcurrency;
}

export function parsePlanResponse(raw: string): ParsedPlan {
  const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ?? [null, raw];
  const jsonStr = jsonMatch[1] || raw;

  let parsed: RawPlanResponse;
  try {
    parsed = JSON.parse(jsonStr.trim());
  } catch {
    throw new Error('Invalid JSON in ticket agent response');
  }

  if (!parsed.tickets || !Array.isArray(parsed.tickets)) {
    throw new Error('Invalid plan: missing tickets array');
  }
  if (!parsed.concurrency) {
    throw new Error('Invalid plan: missing concurrency');
  }

  for (const ticket of parsed.tickets) {
    if (!ticket.title) throw new Error('Invalid ticket: missing title');
    if (!ticket.files || ticket.files.length === 0) {
      throw new Error(`Ticket "${ticket.title}" must list files it will touch`);
    }
    if (!ticket.acceptance_criteria || ticket.acceptance_criteria.length === 0) {
      throw new Error(`Ticket "${ticket.title}" must have acceptance criteria`);
    }
  }

  return {
    tickets: parsed.tickets,
    plan: parsed.concurrency,
  };
}
