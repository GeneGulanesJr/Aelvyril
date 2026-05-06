import { describe, it, expect } from 'vitest';
import { ChatHandler } from '../../src/supervisor/chat-handler.js';

describe('ChatHandler', () => {
  it('routes a new request message', async () => {
    const dispatched: string[] = [];
    const handler = new ChatHandler({
      onNewRequest: (content) => dispatched.push(`request:${content}`),
      onRedirect: (ticketId, content) => dispatched.push(`redirect:${ticketId}:${content}`),
      onStatusCheck: () => dispatched.push('status'),
      onCancel: () => dispatched.push('cancel'),
      onConfigUpdate: () => dispatched.push('config'),
    });

    await handler.handleMessage('ses_123', 'Add dark mode');
    expect(dispatched).toEqual(['request:Add dark mode']);
  });

  it('routes a cancel message', async () => {
    const dispatched: string[] = [];
    const handler = new ChatHandler({
      onNewRequest: (content) => dispatched.push(`request:${content}`),
      onRedirect: () => {},
      onStatusCheck: () => dispatched.push('status'),
      onCancel: () => dispatched.push('cancel'),
      onConfigUpdate: () => {},
    });

    await handler.handleMessage('ses_123', 'stop everything');
    expect(dispatched).toEqual(['cancel']);
  });
});
