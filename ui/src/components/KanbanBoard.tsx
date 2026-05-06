import { TicketCard } from './TicketCard.js';

interface BoardTicket {
  id: string;
  title: string;
  status: string;
  priority: number;
  cost_tokens: number;
  cost_usd: number;
  assigned_agent: string | null;
  reject_count?: number;
  held_reason?: string | null;
}

interface KanbanBoardProps {
  tickets: BoardTicket[];
}

const COLUMNS = [
  { key: 'backlog', label: 'Backlog', icon: '📋' },
  { key: 'in_progress', label: 'In Progress', icon: '🔨' },
  { key: 'testing', label: 'Testing', icon: '🧪' },
  { key: 'in_review', label: 'In Review', icon: '🔍' },
  { key: 'done', label: 'Done', icon: '✅' },
] as const;

export function KanbanBoard({ tickets }: KanbanBoardProps) {
  return (
    <div className="kanban-board">
      {COLUMNS.map(({ key, label, icon }) => {
        const columnTickets = tickets.filter(t => t.status === key);
        return (
          <div key={key} className="kanban-column">
            <div className="kanban-column-header">
              <span>{icon}</span>
              <span>{label}</span>
              <span className="kanban-count">{columnTickets.length}</span>
            </div>
            <div className="kanban-column-body">
              {columnTickets.map(ticket => (
                <TicketCard key={ticket.id} {...ticket} />
              ))}
            </div>
          </div>
        );
      })}
      {tickets.some(t => t.status === 'held') && (
        <div className="kanban-held-notice">
          ⏸ {tickets.filter(t => t.status === 'held').length} ticket(s) on hold
        </div>
      )}
    </div>
  );
}
