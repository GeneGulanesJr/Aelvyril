interface DepGraphTicket {
  id: string;
  title: string;
  status: string;
  dependencies: string[];
}

interface DepGraphProps {
  tickets: DepGraphTicket[];
}

export function DepGraph({ tickets }: DepGraphProps) {
  const ticketMap = new Map(tickets.map(t => [t.id, t]));

  const edges: { from: string; to: string; fromStatus: string; toStatus: string }[] = [];
  for (const ticket of tickets) {
    for (const depId of ticket.dependencies) {
      const dep = ticketMap.get(depId);
      if (dep) {
        edges.push({ from: depId, to: ticket.id, fromStatus: dep.status, toStatus: ticket.status });
      }
    }
  }

  const statusColor = (status: string) => {
    switch (status) {
      case 'done': return 'var(--accent-green)';
      case 'in_progress': return 'var(--accent-blue)';
      case 'testing': return 'var(--accent-purple)';
      case 'in_review': return '#4db6ac';
      case 'held': return 'var(--accent-yellow)';
      default: return 'var(--text-dim)';
    }
  };

  return (
    <div className="dep-graph">
      <div className="dep-graph-header">
        <h3>Dependency Graph</h3>
        <span className="dep-graph-stats">{tickets.length} tickets, {edges.length} dependencies</span>
      </div>

      {edges.length === 0 && tickets.length > 0 && (
        <div className="dep-graph-empty">No dependencies between tickets</div>
      )}

      {edges.length === 0 && tickets.length === 0 && (
        <div className="dep-graph-empty">No tickets loaded</div>
      )}

      {edges.length > 0 && (
        <div className="dep-graph-edges">
          {edges.map((edge, i) => (
            <div key={i} className="dep-graph-edge">
              <span className="dep-graph-node" style={{ color: statusColor(edge.fromStatus) }}>
                {edge.from}
              </span>
              <span className="dep-graph-arrow">&rarr;</span>
              <span className="dep-graph-node" style={{ color: statusColor(edge.toStatus) }}>
                {edge.to}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="dep-graph-tickets">
        <h4>All Tickets</h4>
        <table className="dep-graph-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Title</th>
              <th>Status</th>
              <th>Depends On</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map(ticket => (
              <tr key={ticket.id}>
                <td style={{ color: statusColor(ticket.status) }}>{ticket.id}</td>
                <td>{ticket.title}</td>
                <td>
                  <span className="dep-graph-status" style={{ color: statusColor(ticket.status) }}>
                    {ticket.status}
                  </span>
                </td>
                <td>
                  {ticket.dependencies.length > 0
                    ? ticket.dependencies.join(', ')
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
