import { createServer } from './server.js';
import { Database } from './db/database.js';
import { ConfigManager } from './config/config-manager.js';
import path from 'path';
import os from 'os';

const configPath = path.join(os.homedir(), '.aelvyril', 'config.json');
const dbPath = path.join(os.homedir(), '.aelvyril', 'aelvyril.db');

const db = new Database(dbPath);
const configManager = new ConfigManager(db, configPath);
const config = configManager.load();

const server = createServer(db, config.port);

server.listen(config.port, () => {
  console.log(`Aelvyril Orchestrator running on http://localhost:${config.port}`);
  console.log(`WebSocket at ws://localhost:${config.port}/ws`);
  console.log(`Database: ${dbPath}`);
});

process.on('SIGINT', () => {
  server.close();
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  server.close();
  db.close();
  process.exit(0);
});
