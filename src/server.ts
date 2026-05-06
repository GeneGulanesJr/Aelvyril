import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import type { Database } from './db/database.js';
import { registerSessionRoutes } from './routes/session-routes.js';
import { registerConfigRoutes } from './routes/config-routes.js';
import { handleWebSocketConnection } from './routes/ws-handler.js';
import type { Orchestrator } from './orchestrator.js';

const UI_DIST = path.resolve(process.cwd(), 'ui', 'dist');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const urlPath = req.url ?? '/';
  let filePath = path.join(UI_DIST, urlPath === '/' ? 'index.html' : urlPath.slice(1));

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(UI_DIST, 'index.html');
  }

  if (fs.existsSync(filePath)) {
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  return false;
}

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

    if (serveStatic(req, res)) {
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
