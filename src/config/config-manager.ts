import fs from 'fs';
import path from 'path';
import type { Database } from '../db/database.js';
import type { AelvyrilConfig } from '../types/common.js';
import { encrypt, decrypt } from './crypto.js';

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

  private decryptApiKeys(config: AelvyrilConfig): void {
    for (const [provider, key] of Object.entries(config.api_keys)) {
      if (key && key.includes(':')) {
        try {
          config.api_keys[provider] = decrypt(key);
        } catch {
          // If decryption fails, keep as-is (might be plaintext from before encryption)
        }
      }
    }
  }

  private encryptApiKeys(config: AelvyrilConfig): Record<string, string> {
    const encrypted: Record<string, string> = {};
    for (const [provider, key] of Object.entries(config.api_keys)) {
      if (key && !key.includes(':')) {
        encrypted[provider] = encrypt(key);
      } else {
        encrypted[provider] = key;
      }
    }
    return encrypted;
  }

  private mergeAll(): AelvyrilConfig {
    let config = { ...DEFAULT_CONFIG };

    const dbConfig = this.db.getConfig('config');
    if (dbConfig) {
      try {
        config = { ...config, ...JSON.parse(dbConfig) };
      } catch {}
    }

    if (fs.existsSync(this.configPath)) {
      try {
        const fileConfig = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
        config = { ...config, ...fileConfig };
      } catch {}
    }

    this.decryptApiKeys(config);
    return config;
  }

  load(): AelvyrilConfig {
    return { ...this.config };
  }

  save(partial: Partial<AelvyrilConfig>): void {
    this.config = { ...this.config, ...partial };

    const toPersist = { ...this.config };
    toPersist.api_keys = this.encryptApiKeys(this.config);

    this.db.setConfig('config', JSON.stringify(toPersist));

    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.configPath, JSON.stringify(toPersist, null, 2));
  }
}
