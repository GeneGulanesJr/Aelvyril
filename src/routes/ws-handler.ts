import type { WebSocket } from 'ws';
import type { Orchestrator } from '../orchestrator.js';

export function handleWebSocketConnection(orchestrator: Orchestrator, ws: WebSocket): void {
  ws.send(JSON.stringify({
    event: 'connected',
    data: { message: 'Aelvyril WebSocket connected' },
    timestamp: new Date().toISOString(),
  }));

  const onBoardEvent = (_event: string, message: unknown) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(typeof message === 'string' ? message : JSON.stringify(message));
    }
  };

  orchestrator.boardEvents.onBoardChange(onBoardEvent);

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.event === 'chat_message') {
        const sessionId = msg.data?.session_id ?? msg.session_id;
        const content = msg.data?.content ?? msg.content;
        if (sessionId && content) {
          await orchestrator.routeMessage(sessionId, content);
        }
      }
    } catch {
      // Ignore malformed messages
    }
  });

  ws.on('close', () => {
    orchestrator.boardEvents.removeBoardChange(onBoardEvent);
  });
}
