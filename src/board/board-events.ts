import type { Ticket, BoardState } from '../types/common.js';

type BoardEventCallback = (event: string, data: unknown) => void;

export class BoardEvents {
  private callbacks: BoardEventCallback[] = [];

  onBoardChange(callback: BoardEventCallback): void {
    this.callbacks.push(callback);
  }

  off(_event: string, callback: BoardEventCallback): void {
    const idx = this.callbacks.indexOf(callback);
    if (idx !== -1) {
      this.callbacks.splice(idx, 1);
    }
  }

  removeBoardChange(callback: BoardEventCallback): void {
    const idx = this.callbacks.indexOf(callback);
    if (idx !== -1) {
      this.callbacks.splice(idx, 1);
    }
  }

  emitTicketCreated(ticket: Ticket): void {
    this.emit('ticket_created', ticket);
  }

  emitTicketTransition(ticketId: string, from: string, to: string): void {
    this.emit('ticket_transition', { ticket_id: ticketId, from, to });
  }

  emitTicketHeld(ticketId: string, reason: string): void {
    this.emit('ticket_held', { ticket_id: ticketId, reason });
  }

  emitTicketReleased(ticketId: string): void {
    this.emit('ticket_released', { ticket_id: ticketId });
  }

  emitBoardState(state: BoardState): void {
    this.emit('board_state', state);
  }

  private emit(event: string, data: unknown): void {
    const message = { event, data, timestamp: new Date().toISOString() };
    for (const cb of this.callbacks) {
      cb(event, message);
    }
  }
}
