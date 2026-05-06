import type { Orchestrator } from '../orchestrator.js';
import type { IncomingMessage, ServerResponse } from 'http';

export function registerSessionRoutes(
  orchestrator: Orchestrator,
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  const url = new URL(req.url ?? '/', `http://localhost`);
  const path = url.pathname;

  if (path === '/api/sessions' && req.method === 'GET') {
    const sessions = orchestrator.sessionManager.list();
    jsonResponse(res, sessions);
    return true;
  }

  if (path === '/api/sessions' && req.method === 'POST') {
    readBody(req).then((body: any) => {
      const { sessionId } = orchestrator.startSession(body.repo_url);
      jsonResponse(res, { id: sessionId, status: 'active' }, 201);
    });
    return true;
  }

  const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch && req.method === 'GET') {
    const session = orchestrator.sessionManager.get(sessionMatch[1]);
    if (!session) { jsonResponse(res, { error: 'Not found' }, 404); return true; }
    jsonResponse(res, session);
    return true;
  }

  if (sessionMatch && req.method === 'DELETE') {
    orchestrator.destroySession(sessionMatch[1]);
    jsonResponse(res, { ok: true });
    return true;
  }

  const boardMatch = path.match(/^\/api\/sessions\/([^/]+)\/board$/);
  if (boardMatch && req.method === 'GET') {
    const board = orchestrator.getBoard(boardMatch[1]);
    if (!board) { jsonResponse(res, { error: 'Not found' }, 404); return true; }
    const plan = board.getConcurrencyPlan();
    jsonResponse(res, {
      session_id: boardMatch[1],
      tickets: board.getTickets(),
      plan,
    });
    return true;
  }

  const costMatch = path.match(/^\/api\/sessions\/([^/]+)\/cost$/);
  if (costMatch && req.method === 'GET') {
    const board = orchestrator.getBoard(costMatch[1]);
    if (!board) { jsonResponse(res, { error: 'Not found' }, 404); return true; }
    const tickets = board.getTickets();
    const totalTokens = tickets.reduce((sum, t) => sum + t.cost_tokens, 0);
    const totalCost = tickets.reduce((sum, t) => sum + t.cost_usd, 0);
    jsonResponse(res, {
      session_id: costMatch[1],
      total_tokens: totalTokens,
      total_cost_usd: totalCost,
      by_agent: {},
      by_ticket: Object.fromEntries(tickets.map(t => [t.id, { tokens: t.cost_tokens, cost: t.cost_usd }])),
    });
    return true;
  }

  const auditMatch = path.match(/^\/api\/sessions\/([^/]+)\/audit$/);
  if (auditMatch && req.method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const rows = orchestrator.db.raw.prepare(
      'SELECT * FROM audit_log WHERE session_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?'
    ).all(auditMatch[1], limit, offset);
    jsonResponse(res, rows);
    return true;
  }

  return false;
}

function jsonResponse(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}
