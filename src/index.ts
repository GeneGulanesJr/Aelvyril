import { createServer } from './server.js';
import { Database } from './db/database.js';
import { ConfigManager } from './config/config-manager.js';
import { Orchestrator } from './orchestrator.js';
import path from 'path';
import os from 'os';

function expandHome(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return path.join(os.homedir(), filepath.slice(2));
  }
  return filepath;
}

const configPath = path.join(os.homedir(), '.aelvyril', 'config.json');
const db = new Database(expandHome('~/.aelvyril/aelvyril.db'));
const configManager = new ConfigManager(db, configPath);
const config = configManager.load();

const orchestrator = new Orchestrator({
  port: config.port,
  workspaceRoot: expandHome('~/.aelvyril/workspaces'),
  dbPath: expandHome(config.db_path),
});

const server = createServer(db, config.port, orchestrator);

server.listen(config.port, () => {
  console.log(`Aelvyril Orchestrator running on http://localhost:${config.port}`);
  console.log(`WebSocket at ws://localhost:${config.port}/ws`);
  console.log(`Database: ${expandHome(config.db_path)}`);
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
