import type { AgentPool } from './agent-pool.js';
import type { AgentType } from '../types/common.js';
import { JsonRpcClient } from './json-rpc.js';

export interface HealthMonitorConfig {
  intervalMs: number;
  timeoutMs: number;
  onCrash: (agentId: string, agentType: AgentType) => void;
  onUnresponsive: (agentId: string, agentType: AgentType) => void;
}

interface PendingHealthcheck {
  sentAt: number;
  agentType: AgentType;
}

export class AgentHealthMonitor {
  private interval: ReturnType<typeof setInterval> | null = null;
  private rpc = new JsonRpcClient();
  private pending: Map<string, PendingHealthcheck> = new Map();

  constructor(
    private pool: AgentPool,
    private config: HealthMonitorConfig
  ) {}

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.check(), this.config.intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  handleResponse(agentId: string, raw: string): void {
    try {
      this.rpc.parseResponse(raw);
      this.pending.delete(agentId);
      const agent = this.pool.get(agentId);
      if (agent) {
        agent.updateHealthcheck();
      }
    } catch {
      // Response parse error — will be caught by timeout
    }
  }

  private check(): void {
    const now = Date.now();
    const statuses = this.pool.getAllStatuses();

    for (const [id, status] of statuses) {
      if (!status.running) {
        this.config.onCrash(id, status.agentType);
        this.pending.delete(id);
        continue;
      }

      const pending = this.pending.get(id);
      if (pending && (now - pending.sentAt) > this.config.timeoutMs) {
        this.config.onUnresponsive(id, pending.agentType);
        this.pending.delete(id);
        continue;
      }

      if (!this.pending.has(id)) {
        const agent = this.pool.get(id);
        if (agent) {
          const request = this.rpc.createRequest('healthcheck', {});
          agent.send(this.rpc.frame(request));
          this.pending.set(id, { sentAt: now, agentType: status.agentType });
        }
      }
    }
  }
}
