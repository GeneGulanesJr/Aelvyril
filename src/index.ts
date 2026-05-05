// src/index.ts
import { createServer } from './server.js';
import { Database } from './db/database.js';
import { ConfigManager } from './config/config-manager.js';
import path from 'path';
import os from 'os';

const homeDir = os.homedir();
const configPath = path.join(homeDir, '.aelvyril', 'config.json');
const dbPath = path.join(homeDir, '.aelvyril', 'aelvyril.db');

const db = new Database(dbPath);
const configManager = new ConfigManager(db, configPath);
const config = configManager.load();

const server = createServer(config.port);

server.listen(config.port, () => {
  console.log(`🚀 Aelvyril Orchestrator v0.1.0`);
  console.log(`   HTTP:  http://localhost:${config.port}`);
  console.log(`   WS:    ws://localhost:${config.port}/ws`);
  console.log(`   Health: http://localhost:${config.port}/health`);
  console.log(`   DB:    ${dbPath}`);
  console.log(`   Config: ${configPath}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  server.close();
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  server.close();
  db.close();
  process.exit(0);
});
