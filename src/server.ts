import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Database } from './db/database.js';

interface WebSocketClient extends WebSocket {
  sessionId?: string;
}

export function createServer(db: Database, port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocketClient) => {
    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        ws.send(JSON.stringify({ type: 'ack', timestamp: new Date().toISOString() }));
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    });

    ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
  });

  return server;
}
