import type { CostReport } from '../api/client.js';

interface CostDashboardProps {
  report: CostReport | null;
}

export function CostDashboard({ report }: CostDashboardProps) {
  if (!report) {
    return <div className="cost-dashboard"><div className="cost-empty">No cost data yet</div></div>;
  }

  const agents = Object.entries(report.by_agent);
  const tickets = Object.entries(report.by_ticket);

  return (
    <div className="cost-dashboard">
      <div className="cost-header">
        <h3>Session Cost</h3>
        <div className="cost-total">
          <span className="cost-tokens">{report.total_tokens.toLocaleString()} tokens</span>
          <span className="cost-usd">${report.total_cost_usd.toFixed(4)}</span>
        </div>
      </div>

      <div className="cost-section">
        <h4>By Agent</h4>
        <table className="cost-table">
          <thead>
            <tr><th>Agent</th><th>Tokens</th><th>Cost</th></tr>
          </thead>
          <tbody>
            {agents.map(([agent, data]) => (
              <tr key={agent}>
                <td className="cost-agent-name">{agent}</td>
                <td>{data.tokens.toLocaleString()}</td>
                <td>${data.cost.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="cost-section">
        <h4>By Ticket</h4>
        <table className="cost-table">
          <thead>
            <tr><th>Ticket</th><th>Tokens</th><th>Cost</th></tr>
          </thead>
          <tbody>
            {tickets.map(([ticket, data]) => (
              <tr key={ticket}>
                <td>{ticket}</td>
                <td>{data.tokens.toLocaleString()}</td>
                <td>${data.cost.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
