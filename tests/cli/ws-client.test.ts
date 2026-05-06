import { describe, it, expect, afterEach } from 'vitest';
import { WSClient } from '../../src/cli/ws-client.js';

describe('WSClient', () => {
  let clients: WSClient[] = [];

  afterEach(() => {
    for (const c of clients) {
      c.disconnect();
    }
    clients = [];
  });

  it('creates a client with default config', () => {
    const client = new WSClient({ url: 'ws://localhost:9999' });
    clients.push(client);
    expect(client.isConnected()).toBe(false);
  });

  it('emits connected event on successful connection', async () => {
    const client = new WSClient({ url: 'ws://localhost:9999' });
    clients.push(client);

    const events: string[] = [];
    client.on('connected', () => events.push('connected'));
    client.on('disconnected', () => events.push('disconnected'));
    client.on('message', (data) => events.push(`message:${JSON.stringify(data)}`));

    client.emit('connected');
    expect(events).toEqual(['connected']);
  });

  it('tracks reconnection state', () => {
    const client = new WSClient({
      url: 'ws://localhost:9999',
      reconnect: true,
      reconnectMaxDelayMs: 5000,
    });
    clients.push(client);
    expect(client.isReconnecting()).toBe(false);
  });

  it('formats send messages as JSON', () => {
    const client = new WSClient({ url: 'ws://localhost:9999' });
    clients.push(client);

    const sent: string[] = [];
    (client as any)._send = (data: string) => sent.push(data);

    client.send('chat_message', { content: 'hello' });
    expect(sent).toHaveLength(1);
    const parsed = JSON.parse(sent[0]);
    expect(parsed.event).toBe('chat_message');
    expect(parsed.data.content).toBe('hello');
  });
});
