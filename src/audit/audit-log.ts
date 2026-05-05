// src/audit/audit-log.ts
import type { Database } from '../db/database.js';
import type { AuditEntry, AgentType } from '../types/common.js';

export class AuditLog {
  constructor(private db: Database) {}

  log(
    sessionId: string,
    agentType: AgentType,
    ticketId: string | null,
    action: string,
    details: string | null
  ): void {
    this.db.insertAuditEntry({
      session_id: sessionId,
      agent_type: agentType,
      ticket_id: ticketId,
      action,
      details,
      timestamp: new Date().toISOString(),
    });
  }

  getRecent(sessionId: string, limit = 100): AuditEntry[] {
    return this.db.getAuditLog(sessionId, limit);
  }
}
