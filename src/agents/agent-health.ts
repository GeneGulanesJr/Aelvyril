import type { AgentPool } from './agent-pool.js';
import type { AgentType } from '../types/common.js';

export interface HealthMonitorConfig {
  intervalMs: number;
  timeoutMs: number;
  onCrash: (agentId: string, agentType: AgentType) => void;
  onUnresponsive: (agentId: string, agentType: AgentType) => void;
}

export class AgentHealthMonitor {
  private interval: ReturnType<typeof setInterval> | null = null;

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

  private check(): void {
    const statuses = this.pool.getAllStatuses();
    for (const [id, status] of statuses) {
      if (!status.running) {
        this.config.onCrash(id, status.agentType);
      }
    }
  }
}
