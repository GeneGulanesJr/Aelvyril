// tests/config/config-manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigManager } from '../../src/config/config-manager.js';
import { Database } from '../../src/db/database.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('ConfigManager', () => {
  let cm: ConfigManager;
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-cfg-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    cm = new ConfigManager(db, path.join(tmpDir, 'config.json'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults when no config exists', () => {
    const config = cm.load();
    expect(config.port).toBe(3456);
    expect(config.max_parallel).toBe(2);
    expect(config.git.branch_prefix).toBe('aelvyril');
    expect(config.watchdog.heartbeat_interval_ms).toBe(5000);
    expect(config.watchdog.stuck_threshold_ms).toBe(300000);
  });

  it('saves and loads API keys', () => {
    cm.save({ api_keys: { anthropic: 'sk-test-key' } });
    const config = cm.load();
    expect(config.api_keys.anthropic).toBe('sk-test-key');
  });

  it('persists to file and DB — survives reload', () => {
    cm.save({ max_parallel: 4 });
    // Reload from scratch
    const cm2 = new ConfigManager(db, path.join(tmpDir, 'config.json'));
    const config = cm2.load();
    expect(config.max_parallel).toBe(4);
  });

  it('sets model per agent type', () => {
    cm.save({
      models: {
        supervisor: 'claude-sonnet-4-20250514',
        sub: 'claude-opus-4-20250514',
      },
    });
    const config = cm.load();
    expect(config.models.supervisor).toBe('claude-sonnet-4-20250514');
    expect(config.models.sub).toBe('claude-opus-4-20250514');
  });

  it('deep merges nested objects', () => {
    cm.save({ watchdog: { heartbeat_interval_ms: 2000 } });
    const config = cm.load();
    expect(config.watchdog.heartbeat_interval_ms).toBe(2000);
    // Other watchdog defaults preserved
    expect(config.watchdog.stuck_threshold_ms).toBe(300000);
  });

  it('overwrites scalar values', () => {
    cm.save({ port: 8080 });
    cm.save({ port: 9090 });
    const config = cm.load();
    expect(config.port).toBe(9090);
  });
});
