import { classifyIntent } from './supervisor-agent.js';

export interface ChatHandlerCallbacks {
  onNewRequest: (content: string) => Promise<void> | void;
  onRedirect: (ticketId: string, content: string) => Promise<void> | void;
  onStatusCheck: () => Promise<unknown> | unknown;
  onCancel: () => Promise<void> | void;
  onConfigUpdate: (key: string, value: unknown) => Promise<void> | void;
}

export class ChatHandler {
  constructor(private callbacks: ChatHandlerCallbacks) {}

  async handleMessage(sessionId: string, content: string): Promise<unknown> {
    const intent = classifyIntent(content);

    switch (intent.type) {
      case 'new_request':
        return this.callbacks.onNewRequest(intent.content);
      case 'redirect':
        return this.callbacks.onRedirect(intent.ticket_id, intent.content);
      case 'status_check':
        return this.callbacks.onStatusCheck();
      case 'cancel':
        return this.callbacks.onCancel();
      case 'config_update':
        return this.callbacks.onConfigUpdate(intent.key, intent.value);
      case 'unknown':
        return this.callbacks.onNewRequest(content);
    }
  }
}
