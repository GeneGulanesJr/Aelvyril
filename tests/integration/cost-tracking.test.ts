import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Database } from '../../src/db/database.js';
import { SessionManager } from '../../src/sessions/session-manager.js';
import { CostTracker, toSpecFormat } from '../../src/cost/cost-tracker.js';

describe('Cost tracking', () => {
  let db: Database;
  let tracker: CostTracker;
  let tmpDir: string;
  let sessionId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-cost-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    const sm = new SessionManager(db, path.join(tmpDir, 'workspaces'));
    const session = sm.create('/tmp/fake-repo');
    sessionId = session.id;
    tracker = new CostTracker(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records and reports costs for multiple agents and tickets', () => {
    tracker.record(sessionId, 'supervisor', null, 'gpt-4', 1000, 500, 0.15);
    tracker.record(sessionId, 'ticket', null, 'gpt-4', 2000, 1000, 0.30);
    tracker.record(sessionId, 'main', '#1', 'gpt-4', 3000, 1500, 0.45);
    tracker.record(sessionId, 'test', '#1', 'gpt-4', 500, 200, 0.07);
    tracker.record(sessionId, 'review', '#2', 'gpt-4', 800, 400, 0.12);

    const report = tracker.getReport(sessionId);

    expect(report.session_id).toBe(sessionId);
    expect(report.total_tokens).toBe(10900);
    expect(report.total_cost_usd).toBeCloseTo(1.09);

    expect(report.by_agent.supervisor.tokens).toBe(1500);
    expect(report.by_agent.supervisor.cost).toBeCloseTo(0.15);
    expect(report.by_agent.main.tokens).toBe(4500);
    expect(report.by_agent.main.cost).toBeCloseTo(0.45);

    expect(report.by_ticket['#1']).toBeDefined();
    expect(report.by_ticket['#1']!.tokens).toBe(5200);
    expect(report.by_ticket['#1']!.cost).toBeCloseTo(0.52);
    expect(report.by_ticket['#2']).toBeDefined();
    expect(report.by_ticket['#2']!.tokens).toBe(1200);
    expect(report.by_ticket['#2']!.cost).toBeCloseTo(0.12);
  });

  it('includes all agent types in by_agent even with zero entries', () => {
    tracker.record(sessionId, 'supervisor', null, 'gpt-4', 100, 50, 0.01);

    const report = tracker.getReport(sessionId);

    expect(report.by_agent.supervisor.tokens).toBe(150);
    expect(report.by_agent.ticket.tokens).toBe(0);
    expect(report.by_agent.ticket.cost).toBe(0);
    expect(report.by_agent.main.tokens).toBe(0);
    expect(report.by_agent.sub.tokens).toBe(0);
    expect(report.by_agent.test.tokens).toBe(0);
    expect(report.by_agent.review.tokens).toBe(0);
    expect(report.by_agent.watchdog.tokens).toBe(0);
  });

  it('returns zero totals when no entries exist', () => {
    const report = tracker.getReport(sessionId);

    expect(report.total_tokens).toBe(0);
    expect(report.total_cost_usd).toBe(0);
    expect(Object.keys(report.by_ticket)).toHaveLength(0);
  });

  it('toSpecFormat remaps agent type keys', () => {
    tracker.record(sessionId, 'supervisor', null, 'gpt-4', 100, 50, 0.01);
    tracker.record(sessionId, 'main', '#1', 'gpt-4', 200, 100, 0.03);

    const report = tracker.getReport(sessionId);
    const spec = toSpecFormat(report);

    expect((spec.by_agent as Record<string, unknown>)['supervisor_agent']).toBeDefined();
    expect((spec.by_agent as Record<string, unknown>)['main_agent']).toBeDefined();
    expect((spec.by_agent as Record<string, unknown>)['ticket_agent']).toBeDefined();
    expect((spec.by_agent as Record<string, unknown>)['supervisor']).toBeUndefined();
  });

  it('accumulates costs across multiple entries for same agent', () => {
    tracker.record(sessionId, 'test', '#1', 'gpt-4', 100, 50, 0.01);
    tracker.record(sessionId, 'test', '#1', 'gpt-4', 200, 100, 0.02);
    tracker.record(sessionId, 'test', '#2', 'gpt-4', 300, 150, 0.03);

    const report = tracker.getReport(sessionId);

    expect(report.by_agent.test.tokens).toBe(900);
    expect(report.by_agent.test.cost).toBeCloseTo(0.06);
    expect(report.by_ticket['#1']!.tokens).toBe(450);
    expect(report.by_ticket['#2']!.tokens).toBe(450);
  });
});
