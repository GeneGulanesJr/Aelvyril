import type { IncomingMessage, ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_PATH = path.join(os.homedir(), '.aelvyril', 'config.json');

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfig(config: Record<string, unknown>): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function registerConfigRoutes(
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/api/config' && req.method === 'GET') {
    const config = readConfig();
    if (config.api_keys && typeof config.api_keys === 'object') {
      const masked: Record<string, string> = {};
      for (const [key, val] of Object.entries(config.api_keys as Record<string, string>)) {
        masked[key] = val ? `${val.slice(0, 4)}${'*'.repeat(Math.max(0, val.length - 4))}` : '';
      }
      config.api_keys = masked;
    }
    jsonResponse(res, config);
    return true;
  }

  if (url.pathname === '/api/config' && req.method === 'PUT') {
    readBody(req).then((body: any) => {
      const current = readConfig();
      const updated = { ...current, ...body };
      if (body.api_keys && current.api_keys) {
        for (const [key, val] of Object.entries(body.api_keys as Record<string, string>)) {
          if (val.includes('*')) {
            (updated.api_keys as Record<string, string>)[key] = (current.api_keys as Record<string, string>)[key];
          }
        }
      }
      writeConfig(updated);
      jsonResponse(res, updated);
    });
    return true;
  }

  return false;
}

function jsonResponse(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}
