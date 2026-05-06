import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Orchestrator } from '../../src/orchestrator.js';
import { registerSessionRoutes } from '../../src/routes/session-routes.js';
import { registerConfigRoutes } from '../../src/routes/config-routes.js';

describe('API endpoints', () => {
  let orchestrator: Orchestrator;
  let server: Server;
  let wss: WebSocketServer;
  let tmpDir: string;
  let port: number;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-api-'));
    orchestrator = new Orchestrator({
      port: 0,
      workspaceRoot: path.join(tmpDir, 'workspaces'),
      dbPath: path.join(tmpDir, 'test.db'),
    });

    server = createServer((req, res) => {
      if (!registerSessionRoutes(orchestrator, req, res)) {
        if (!registerConfigRoutes(req, res)) {
          res.writeHead(404);
          res.end('Not found');
        }
      }
    });

    await new Promise<void>(resolve => server.listen(0, () => resolve()));
    port = (server.address() as any).port;

    wss = new WebSocketServer({ server });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        ws.send(data.toString());
      });
    });
  });

  afterEach(() => {
    wss.close();
    server.close();
    orchestrator.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/sessions returns empty list', async () => {
    const res = await fetch(`http://localhost:${port}/api/sessions`);
    const data = await res.json();
    expect(data).toEqual([]);
  });

  it('GET /api/config returns config object', async () => {
    const res = await fetch(`http://localhost:${port}/api/config`);
    const data = await res.json();
    expect(data).toBeDefined();
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`http://localhost:${port}/api/unknown`);
    expect(res.status).toBe(404);
  });
});
