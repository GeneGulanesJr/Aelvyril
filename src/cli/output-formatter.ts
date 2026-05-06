const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';

export function formatSupervisorResponse(message: string): string {
  return `${GREEN}${BOLD}[Supervisor]${RESET} ${message}`;
}

export function formatTicketEvent(
  ticketId: string,
  newStatus: string,
  oldStatus: string | null
): string {
  if (newStatus === 'held') {
    return `${YELLOW}${BOLD}[Ticket]${RESET} ${ticketId} → ${YELLOW}HELD${RESET}`;
  }
  const arrow = oldStatus ? `${oldStatus} → ` : '';
  return `${CYAN}${BOLD}[Ticket]${RESET} ${ticketId} ${arrow}${newStatus}`;
}

export function formatAgentActivity(agent: string, action: string): string {
  return `${BLUE}${BOLD}[${agent}]${RESET} ${action}`;
}

export function formatCostUpdate(tokens: number, costUsd: number): string {
  return `${DIM}💰 ${tokens.toLocaleString()} tokens · $${costUsd.toFixed(4)}${RESET}`;
}

export function formatProgressReport(report: {
  total_tickets: number;
  status: Record<string, number>;
  alerts: { ticket: string; type: string; message: string }[];
}): string {
  const { total_tickets, status, alerts } = report;
  const parts = [`${total_tickets} tickets:`];

  const statusLabels: Record<string, string> = {
    done: 'done', in_progress: 'in_progress', testing: 'testing',
    in_review: 'in_review', backlog: 'backlog', held: 'held',
  };

  for (const [key, label] of Object.entries(statusLabels)) {
    const count = status[key] ?? 0;
    if (count > 0) parts.push(`${count} ${label}`);
  }

  let result = `${BOLD}[Progress]${RESET} ${parts.join(', ')}`;

  if (alerts.length > 0) {
    result += '\n';
    for (const alert of alerts) {
      result += `${RED}  ⚠ ${alert.ticket}: ${alert.type} — ${alert.message}${RESET}\n`;
    }
  }

  return result;
}

export function formatError(message: string): string {
  return `${RED}${BOLD}[Error]${RESET} ${RED}${message}${RESET}`;
}

export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}
