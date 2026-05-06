import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CostTracker } from '../../src/cost/cost-tracker.js';
import { Database } from '../../src/db/database.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('CostTracker', () => {
  let tracker: CostTracker;
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-cost-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    tracker = new CostTracker(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('tracks a cost entry', () => {
    tracker.record('ses_123', 'supervisor', null, 'claude-sonnet', 1000, 500, 0.03);
    const report = tracker.getReport('ses_123');
    expect(report.total_tokens).toBe(1500);
    expect(report.total_cost_usd).toBeCloseTo(0.03);
  });

  it('aggregates by agent type', () => {
    tracker.record('ses_123', 'supervisor', null, 'claude-sonnet', 1000, 500, 0.03);
    tracker.record('ses_123', 'main', null, 'claude-sonnet', 2000, 1000, 0.06);
    tracker.record('ses_123', 'supervisor', '#1', 'claude-sonnet', 500, 200, 0.01);

    const report = tracker.getReport('ses_123');
    expect(report.by_agent.supervisor.tokens).toBe(2200);
    expect(report.by_agent.main.tokens).toBe(3000);
  });

  it('aggregates by ticket', () => {
    tracker.record('ses_123', 'sub', '#1', 'claude-opus', 5000, 2000, 0.50);
    tracker.record('ses_123', 'sub', '#1', 'claude-opus', 3000, 1000, 0.30);

    const report = tracker.getReport('ses_123');
    expect(report.by_ticket['#1'].tokens).toBe(11000);
    expect(report.by_ticket['#1'].cost).toBeCloseTo(0.80);
  });
});
