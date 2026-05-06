import type { Database } from '../db/database.js';
import type { Ticket, TicketStatus, ConcurrencyPlan, TestResult } from '../types/common.js';

interface CreateTicketInput {
  title: string;
  description: string;
  acceptance_criteria: string[];
  dependencies: string[];
  files: string[];
  priority: number;
}

const VALID_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  backlog: ['in_progress'],
  in_progress: ['testing', 'held'],
  testing: ['in_review', 'in_progress', 'held'],
  in_review: ['done', 'backlog', 'held'],
  done: [],
  held: ['in_progress', 'testing', 'in_review'],
};

export class BoardManager {
  private ticketCounter: number;

  constructor(
    private db: Database,
    private sessionId: string
  ) {
    const rows = this.db.raw.prepare(
      'SELECT id FROM tickets WHERE session_id = ? ORDER BY id DESC LIMIT 1'
    ).all(sessionId) as { id: string }[];
    if (rows.length > 0) {
      this.ticketCounter = parseInt(rows[0].id.replace('#', ''), 10);
    } else {
      this.ticketCounter = 0;
    }
  }

  createTicket(input: CreateTicketInput): Ticket {
    this.ticketCounter++;
    const id = `#${this.ticketCounter}`;
    const now = new Date().toISOString();

    this.db.raw.prepare(`
      INSERT INTO tickets (id, session_id, title, description, acceptance_criteria, dependencies, files, priority, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'backlog', ?, ?)
    `).run(
      id, this.sessionId, input.title, input.description,
      JSON.stringify(input.acceptance_criteria),
      JSON.stringify(input.dependencies),
      JSON.stringify(input.files),
      input.priority, now, now
    );

    return this.getTicket(id)!;
  }

  getTicket(id: string): Ticket | null {
    const row = this.db.raw.prepare(
      'SELECT * FROM tickets WHERE id = ? AND session_id = ?'
    ).get(id, this.sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToTicket(row);
  }

  getTickets(): Ticket[] {
    const rows = this.db.raw.prepare(
      'SELECT * FROM tickets WHERE session_id = ? ORDER BY priority DESC, created_at ASC'
    ).all(this.sessionId) as Record<string, unknown>[];
    return rows.map(r => this.rowToTicket(r));
  }

  getTicketsByStatus(status: TicketStatus): Ticket[] {
    const rows = this.db.raw.prepare(
      'SELECT * FROM tickets WHERE session_id = ? AND status = ?'
    ).all(this.sessionId, status) as Record<string, unknown>[];
    return rows.map(r => this.rowToTicket(r));
  }

  transition(id: string, newStatus: TicketStatus): void {
    const ticket = this.getTicket(id);
    if (!ticket) throw new Error(`Ticket ${id} not found`);

    const allowed = VALID_TRANSITIONS[ticket.status];
    if (!allowed.includes(newStatus)) {
      throw new Error(`Invalid transition: ${ticket.status} → ${newStatus}`);
    }

    const now = new Date().toISOString();
    this.db.raw.prepare(
      'UPDATE tickets SET status = ?, updated_at = ? WHERE id = ? AND session_id = ?'
    ).run(newStatus, now, id, this.sessionId);
  }

  hold(id: string, reason: string): void {
    const ticket = this.getTicket(id);
    if (!ticket) throw new Error(`Ticket ${id} not found`);

    if (!VALID_TRANSITIONS[ticket.status].includes('held')) {
      throw new Error(`Cannot hold ticket in ${ticket.status} state`);
    }

    const now = new Date().toISOString();
    this.db.raw.prepare(
      "UPDATE tickets SET status = 'held', held_reason = ?, updated_at = ? WHERE id = ? AND session_id = ?"
    ).run(reason, now, id, this.sessionId);
  }

  release(id: string): void {
    const ticket = this.getTicket(id);
    if (!ticket) throw new Error(`Ticket ${id} not found`);
    if (ticket.status !== 'held') throw new Error(`Ticket ${id} is not held`);

    const now = new Date().toISOString();
    this.db.raw.prepare(
      "UPDATE tickets SET status = 'in_progress', held_reason = NULL, updated_at = ? WHERE id = ? AND session_id = ?"
    ).run(now, id, this.sessionId);
  }

  reject(id: string, notes: string): void {
    const ticket = this.getTicket(id);
    if (!ticket) throw new Error(`Ticket ${id} not found`);

    const now = new Date().toISOString();
    const newRejectCount = (ticket.reject_count ?? 0) + 1;
    this.db.raw.prepare(`
      UPDATE tickets SET status = 'backlog', review_notes = ?, reject_count = ?, updated_at = ?
      WHERE id = ? AND session_id = ?
    `).run(notes, newRejectCount, now, id, this.sessionId);
  }

  setTestResults(id: string, results: TestResult): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(
      'UPDATE tickets SET test_results = ?, updated_at = ? WHERE id = ? AND session_id = ?'
    ).run(JSON.stringify(results), now, id, this.sessionId);
  }

  assignAgent(id: string, agentId: string | null): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(
      'UPDATE tickets SET assigned_agent = ?, updated_at = ? WHERE id = ? AND session_id = ?'
    ).run(agentId, now, id, this.sessionId);
  }

  addCost(id: string, tokens: number, costUsd: number): void {
    this.db.raw.prepare(`
      UPDATE tickets SET cost_tokens = cost_tokens + ?, cost_usd = cost_usd + ?, updated_at = ?
      WHERE id = ? AND session_id = ?
    `).run(tokens, costUsd, new Date().toISOString(), id, this.sessionId);
  }

  saveConcurrencyPlan(plan: ConcurrencyPlan): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(`
      INSERT INTO concurrency_plans (session_id, plan_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET plan_json = ?, updated_at = ?
    `).run(this.sessionId, JSON.stringify(plan), now, now, JSON.stringify(plan), now);
  }

  getConcurrencyPlan(): ConcurrencyPlan | null {
    const row = this.db.raw.prepare(
      'SELECT plan_json FROM concurrency_plans WHERE session_id = ?'
    ).get(this.sessionId) as { plan_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.plan_json);
  }

  private rowToTicket(row: Record<string, unknown>): Ticket {
    return {
      id: row.id as string,
      session_id: row.session_id as string,
      title: row.title as string,
      description: row.description as string,
      acceptance_criteria: JSON.parse(row.acceptance_criteria as string || '[]'),
      dependencies: JSON.parse(row.dependencies as string || '[]'),
      files: JSON.parse(row.files as string || '[]'),
      priority: row.priority as number,
      status: row.status as TicketStatus,
      assigned_agent: row.assigned_agent as string | null,
      test_results: row.test_results ? JSON.parse(row.test_results as string) : null,
      review_notes: row.review_notes as string | null,
      reject_count: row.reject_count as number,
      held_reason: row.held_reason as string | null,
      git_branch: row.git_branch as string | null,
      cost_tokens: row.cost_tokens as number,
      cost_usd: row.cost_usd as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }
}
