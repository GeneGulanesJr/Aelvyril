// src/server.ts
import http from 'http';
import { WebSocketServer, type WebSocket } from 'ws';

interface WSClient extends WebSocket {
  isAlive?: boolean;
}

export function createServer(port: number): http.Server {
  const server = http.createServer((req, res) => {
    // Health check endpoint
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        version: '0.1.0',
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    // 404 for everything else (API routes added in Phase 13)
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  // WebSocket server on /ws path
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WSClient) => {
    ws.isAlive = true;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        // Message routing will be added in Phase 2 (Agent Pool)
        ws.send(JSON.stringify({
          type: 'ack',
          event: msg.event ?? 'unknown',
          timestamp: new Date().toISOString(),
        }));
      } catch {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Invalid JSON',
          timestamp: new Date().toISOString(),
        }));
      }
    });

    // Send welcome message
    ws.send(JSON.stringify({
      type: 'connected',
      timestamp: new Date().toISOString(),
    }));
  });

  // Heartbeat: terminate dead connections every 30s
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws: WSClient) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(heartbeat));

  return server;
}
