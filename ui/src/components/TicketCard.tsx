interface TicketCardProps {
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

export function TicketCard({ id, title, priority, cost_usd, assigned_agent, reject_count, held_reason }: TicketCardProps) {
  return (
    <div className={`ticket-card priority-${priority} ${held_reason ? 'held' : ''}`}>
      <div className="ticket-id">{id}</div>
      <div className="ticket-title">{title}</div>
      <div className="ticket-meta">
        {assigned_agent && <span className="ticket-agent">{assigned_agent}</span>}
        {cost_usd > 0 && <span className="ticket-cost">${cost_usd.toFixed(2)}</span>}
        {reject_count && reject_count > 0 && <span className="ticket-rejects">✗{reject_count}</span>}
      </div>
    </div>
  );
}
