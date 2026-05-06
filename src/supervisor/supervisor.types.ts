export type SupervisorIntent =
  | { type: 'new_request'; content: string }
  | { type: 'redirect'; ticket_id: string; content: string }
  | { type: 'status_check' }
  | { type: 'cancel' }
  | { type: 'config_update'; key: string; value: unknown }
  | { type: 'unknown'; raw: string };

export interface ChatMessage {
  session_id: string;
  content: string;
  timestamp: string;
  direction: 'user_to_supervisor' | 'supervisor_to_user';
}

export interface SupervisorResponse {
  type: 'ack' | 'status' | 'error' | 'notification';
  message: string;
  data?: unknown;
}
