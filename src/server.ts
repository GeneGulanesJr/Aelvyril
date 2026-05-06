import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Database } from './db/database.js';
import { registerSessionRoutes } from './routes/session-routes.js';
import { registerConfigRoutes } from './routes/config-routes.js';
import { handleWebSocketConnection } from './routes/ws-handler.js';
import type { Orchestrator } from './orchestrator.js';

interface WebSocketClient extends WebSocket {
  sessionId?: string;
}

export function createServer(db: Database, port: number, orchestrator?: Orchestrator): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
      return;
    }

    if (orchestrator && registerSessionRoutes(orchestrator, req, res)) {
      return;
    }

    if (registerConfigRoutes(req, res)) {
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocketClient) => {
    if (orchestrator) {
      handleWebSocketConnection(orchestrator, ws);
    } else {
      ws.on('message', (data: Buffer) => {
        try {
          JSON.parse(data.toString());
          ws.send(JSON.stringify({ type: 'ack', timestamp: new Date().toISOString() }));
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        }
      });
      ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
    }
  });

  return server;
}
