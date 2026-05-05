// src/config/config-manager.ts
import fs from 'fs';
import path from 'path';
import type { Database } from '../db/database.js';
import type { AelvyrilConfig, AgentModelConfig } from '../types/common.js';

const DEFAULT_CONFIG: AelvyrilConfig = {
  port: 3456,
  api_keys: {},
  models: {
    supervisor: 'claude-sonnet-4-20250514',
    ticket: 'claude-sonnet-4-20250514',
    main: 'claude-sonnet-4-20250514',
    sub: 'claude-sonnet-4-20250514',
    test: 'claude-sonnet-4-20250514',
    review: 'claude-sonnet-4-20250514',
    watchdog: 'claude-sonnet-4-20250514',
  },
  max_parallel: 2,
  watchdog: {
    heartbeat_interval_ms: 5000,
    stuck_threshold_ms: 300000,
  },
  git: {
    branch_prefix: 'aelvyril',
    auto_merge: true,
  },
  db_path: '~/.aelvyril/aelvyril.db',
  memory_db_dir: '~/.aelvyril/memory',
};

export class ConfigManager {
  private config: AelvyrilConfig;

  constructor(
    private db: Database,
    private configPath: string
  ) {
    this.config = this.mergeAll();
  }

  private mergeAll(): AelvyrilConfig {
    let config = structuredClone(DEFAULT_CONFIG);

    // Load from DB
    const dbConfig = this.db.getConfig('config');
    if (dbConfig) {
      try {
        config = deepMerge(config, JSON.parse(dbConfig));
      } catch { /* ignore corrupt DB config */ }
    }

    // Load from file (highest priority)
    if (fs.existsSync(this.configPath)) {
      try {
        const fileConfig = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
        config = deepMerge(config, fileConfig);
      } catch { /* ignore corrupt file config */ }
    }

    return config;
  }

  load(): AelvyrilConfig {
    return structuredClone(this.config);
  }

  save(partial: Partial<AelvyrilConfig>): void {
    this.config = deepMerge(this.config, partial);

    // Persist to DB
    this.db.setConfig('config', JSON.stringify(this.config));

    // Persist to file
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }
}

function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof T)[]) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal !== null && srcVal !== undefined &&
      typeof srcVal === 'object' && !Array.isArray(srcVal) &&
      tgtVal !== null && tgtVal !== undefined &&
      typeof tgtVal === 'object' && !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>
      ) as T[keyof T];
    } else if (srcVal !== undefined) {
      result[key] = srcVal as T[keyof T];
    }
  }
  return result;
}
