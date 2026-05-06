import WebSocket from 'ws';

export interface WSClientConfig {
  url: string;
  reconnect?: boolean;
  reconnectMaxDelayMs?: number;
  timeoutMs?: number;
}

type EventHandler = (data?: unknown) => void;

export class WSClient {
  private ws: WebSocket | null = null;
  private handlers: Map<string, EventHandler[]> = new Map();
  private reconnectAttempt = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private reconnecting = false;
  private readonly config: Required<WSClientConfig>;

  constructor(config: WSClientConfig) {
    this.config = {
      url: config.url,
      reconnect: config.reconnect ?? true,
      reconnectMaxDelayMs: config.reconnectMaxDelayMs ?? 30000,
      timeoutMs: config.timeoutMs ?? 10000,
    };
  }

  connect(): void {
    this.doConnect();
  }

  private doConnect(): void {
    try {
      this.ws = new WebSocket(this.config.url);
      this.reconnecting = true;

      this.ws.on('open', () => {
        this.connected = true;
        this.reconnecting = false;
        this.reconnectAttempt = 0;
        this.emit('connected');
      });

      this.ws.on('close', () => {
        this.connected = false;
        this.emit('disconnected');
        if (this.config.reconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', () => {});

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const parsed = JSON.parse(data.toString());
          this.emit('message', parsed);
        } catch {
          this.emit('message', data.toString());
        }
      });
    } catch {
      if (this.config.reconnect) {
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt - 1), this.config.reconnectMaxDelayMs);
    this.reconnecting = true;
    this.reconnectTimeout = setTimeout(() => this.doConnect(), delay);
  }

  on(event: string, handler: EventHandler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  off(event: string, handler: EventHandler): void {
    const handlers = this.handlers.get(event) ?? [];
    this.handlers.set(event, handlers.filter(h => h !== handler));
  }

  emit(event: string, data?: unknown): void {
    const handlers = this.handlers.get(event) ?? [];
    for (const h of handlers) {
      h(data);
    }
  }

  _send(data: string): void {
    this.ws?.send(data);
  }

  send(event: string, data: unknown): void {
    const message = JSON.stringify({ event, data });
    this._send(message);
  }

  isConnected(): boolean {
    return this.connected;
  }

  isReconnecting(): boolean {
    return this.reconnecting;
  }

  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.reconnecting = false;
    this.ws?.close();
    this.ws = null;
  }
}
