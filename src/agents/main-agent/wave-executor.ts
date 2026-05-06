// src/agents/main-agent/wave-executor.ts
import type { Ticket, ConcurrencyPlan } from '../../types/common.js';

export function getNextDispatchable(
  tickets: Ticket[],
  plan: ConcurrencyPlan,
  currentlyRunning: number = 0
): string[] {
  const ticketMap = new Map(tickets.map(t => [t.id, t]));
  const dispatchable: string[] = [];
  let slotsAvailable = plan.max_parallel - currentlyRunning;

  for (const wave of plan.waves) {
    const waveAllDone = wave.every(id => ticketMap.get(id)?.status === 'done');
    if (waveAllDone) continue;

    for (const ticketId of wave) {
      if (slotsAvailable <= 0) break;

      const ticket = ticketMap.get(ticketId);
      if (!ticket || ticket.status !== 'backlog') continue;

      const depsDone = ticket.dependencies.every(depId => {
        const dep = ticketMap.get(depId);
        return dep?.status === 'done';
      });

      if (depsDone) {
        dispatchable.push(ticketId);
        slotsAvailable--;
      }
    }

    break;
  }

  return dispatchable;
}
