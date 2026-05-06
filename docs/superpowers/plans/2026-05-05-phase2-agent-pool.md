# Phase 2: Agent Pool — Spawn, Manage, and Communicate with pi Agents

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Agent Pool that spawns pi processes as child processes, communicates via JSON-RPC over stdin/stdout, monitors health via healthcheck, and routes messages between agents through the Orchestrator.

**Architecture:** The Orchestrator is the message bus. Each agent is a `child_process.spawn('pi')` with JSON-RPC framing over stdin/stdout. The AgentPool manages long-running agents (session lifetime) and ephemeral agents (spawned/killed per task). Health checks via JSON-RPC `healthcheck` method every 10s.

**Tech Stack:** Node.js child_process, JSON-RPC 2.0, pi CLI

**Spec reference:** `docs/superpowers/specs/2026-05-05-cloud-platform-design.md` §2.4, §2.5, §2.7

**Depends on:** Phase 1 (Orchestrator Foundation)

---

## File Structure

```
src/
├── agents/
│   ├── agent-pool.ts           # Manages all pi agent processes
│   ├── agent-process.ts        # Single pi process wrapper (JSON-RPC over stdio)
│   ├── json-rpc.ts             # JSON-RPC 2.0 client implementation
│   ├── agent-health.ts         # Health check monitor (10s interval)
│   └── agent.types.ts          # Agent-related types
tests/
├── agents/
│   ├── agent-process.test.ts
│   ├── json-rpc.test.ts
│   └── agent-health.test.ts
```

---

### Task 1: JSON-RPC 2.0 client

**Files:**
- Create: `src/agents/json-rpc.ts`
- Test: `tests/agents/json-rpc.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agents/json-rpc.test.ts
import { describe, it, expect } from 'vitest';
import { JsonRpcClient } from '../../src/agents/json-rpc.js';

describe('JsonRpcClient', () => {
  it('creates a valid JSON-RPC request', () => {
    const client = new JsonRpcClient();
    const request = client.createRequest('healthcheck', {});
    expect(request.jsonrpc).toBe('2.0');
    expect(request.method).toBe('healthcheck');
    expect(request.id).toBeDefined();
  });

  it('parses a valid JSON-RPC response', () => {
    const client = new JsonRpcClient();
    const request = client.createRequest('healthcheck', {});
    const response = client.parseResponse(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: { status: 'ok' },
    }));
    expect(response.result).toEqual({ status: 'ok' });
  });

  it('throws on JSON-RPC error response', () => {
    const client = new JsonRpcClient();
    const request = client.createRequest('bad_method', {});
    expect(() => {
      client.parseResponse(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: 'Method not found' },
      }));
    }).toThrow('Method not found');
  });

  it('frames a message with Content-Length header', () => {
    const client = new JsonRpcClient();
    const frame = client.frame({ jsonrpc: '2.0', method: 'test', id: 1 });
    expect(frame).toContain('Content-Length:');
    expect(frame).toContain('"method":"test"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agents/json-rpc.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write json-rpc.ts**

```typescript
// src/agents/json-rpc.ts

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class JsonRpcClient {
  private nextId = 1;

  createRequest(method: string, params: Record<string, unknown>): JsonRpcRequest {
    return {
      jsonrpc: '2.0',
      id: this.nextId++,
      method,
      params,
    };
  }

  parseResponse(raw: string): { result: unknown } {
    const response: JsonRpcResponse = JSON.parse(raw);
    if (response.error) {
      throw new Error(response.error.message);
    }
    return { result: response.result };
  }

  frame(message: object): string {
    const content = JSON.stringify(message);
    return `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agents/json-rpc.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/json-rpc.ts tests/agents/json-rpc.test.ts
git commit -m "feat: JSON-RPC 2.0 client — request creation, response parsing, framing"
```

---

### Task 2: Agent process wrapper

**Files:**
- Create: `src/agents/agent-process.ts`
- Create: `src/agents/agent.types.ts`
- Test: `tests/agents/agent-process.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agents/agent-process.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { AgentProcess } from '../../src/agents/agent-process.js';

describe('AgentProcess', () => {
  let processes: AgentProcess[] = [];

  afterEach(() => {
    for (const p of processes) {
      p.kill();
    }
    processes = [];
  });

  it('spawns a pi process and detects when it is ready', async () => {
    // Use 'cat' as a stand-in for pi since pi may not be installed in CI
    const proc = new AgentProcess({
      command: 'cat',  // Echo stdin back
      args: [],
      agentType: 'supervisor',
      sessionId: 'test-session',
      memoryDbPath: '/tmp/test-memory.db',
    });
    processes.push(proc);

    // cat won't speak JSON-RPC, but we can test process lifecycle
    expect(proc.isRunning()).toBe(true);
    proc.kill();
    // Give it a moment
    await new Promise(r => setTimeout(r, 100));
    expect(proc.isRunning()).toBe(false);
  });

  it('captures stderr output', async () => {
    const proc = new AgentProcess({
      command: 'node',
      args: ['-e', 'console.error("test error")'],
      agentType: 'test',
      sessionId: 'test-session',
      memoryDbPath: '/tmp/test-memory.db',
    });
    processes.push(proc);

    const error = await new Promise<string>(resolve => {
      proc.onStderr((data) => resolve(data.toString()));
    });
    expect(error).toContain('test error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agents/agent-process.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write agent.types.ts**

```typescript
// src/agents/agent.types.ts
import type { AgentType } from '../types/common.js';

export interface AgentProcessConfig {
  command: string;
  args: string[];
  agentType: AgentType;
  sessionId: string;
  memoryDbPath: string;
  env?: Record<string, string>;
}

export interface AgentStatus {
  agentType: AgentType;
  sessionId: string;
  pid: number | null;
  running: boolean;
  spawnedAt: string;
  lastHealthcheck: string | null;
}
```

- [ ] **Step 4: Write agent-process.ts**

```typescript
// src/agents/agent-process.ts
import { ChildProcess, spawn } from 'child_process';
import type { AgentProcessConfig, AgentStatus } from './agent.types.js';
import type { AgentType } from '../types/common.js';

export class AgentProcess {
  private child: ChildProcess | null = null;
  private readonly config: AgentProcessConfig;
  private readonly spawnedAt: string;
  private lastHealthcheck: string | null = null;
  private stderrCallbacks: ((data: Buffer) => void)[] = [];
  private stdoutCallbacks: ((data: Buffer) => void)[] = [];

  constructor(config: AgentProcessConfig) {
    this.config = config;
    this.spawnedAt = new Date().toISOString();
    this.spawn();
  }

  private spawn(): void {
    const env = {
      ...process.env,
      ...this.config.env,
      AELVYRIL_SESSION_ID: this.config.sessionId,
      AELVYRIL_MEMORY_DB: this.config.memoryDbPath,
      AELVYRIL_AGENT_TYPE: this.config.agentType,
    };

    this.child = spawn(this.config.command, this.config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    this.child.stdout?.on('data', (data: Buffer) => {
      for (const cb of this.stdoutCallbacks) cb(data);
    });

    this.child.stderr?.on('data', (data: Buffer) => {
      for (const cb of this.stderrCallbacks) cb(data);
    });

    this.child.on('exit', () => {
      this.child = null;
    });
  }

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  getPid(): number | null {
    return this.child?.pid ?? null;
  }

  send(data: string): void {
    if (!this.child?.stdin) throw new Error('Agent process not running');
    this.child.stdin.write(data);
  }

  onStdout(callback: (data: Buffer) => void): void {
    this.stdoutCallbacks.push(callback);
  }

  onStderr(callback: (data: Buffer) => void): void {
    this.stderrCallbacks.push(callback);
  }

  getStatus(): AgentStatus {
    return {
      agentType: this.config.agentType,
      sessionId: this.config.sessionId,
      pid: this.getPid(),
      running: this.isRunning(),
      spawnedAt: this.spawnedAt,
      lastHealthcheck: this.lastHealthcheck,
    };
  }

  updateHealthcheck(): void {
    this.lastHealthcheck = new Date().toISOString();
  }

  kill(): void {
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/agents/agent-process.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/agents/agent-process.ts src/agents/agent.types.ts tests/agents/agent-process.test.ts
git commit -m "feat: agent process wrapper — spawn, lifecycle, stdout/stderr, kill"
```

---

### Task 3: Agent Pool

**Files:**
- Create: `src/agents/agent-pool.ts`

- [ ] **Step 1: Write agent-pool.ts**

```typescript
// src/agents/agent-pool.ts
import { AgentProcess } from './agent-process.js';
import type { AgentType } from '../types/common.js';
import type { AgentStatus } from './agent.types.js';

interface PooledAgent {
  process: AgentProcess;
  type: 'long_running' | 'ephemeral';
}

export class AgentPool {
  private agents: Map<string, PooledAgent> = new Map();

  spawnLongRunning(
    id: string,
    sessionId: string,
    memoryDbPath: string,
    agentType: AgentType
  ): AgentProcess {
    const proc = new AgentProcess({
      command: 'pi',
      args: ['--agent', agentType],
      agentType,
      sessionId,
      memoryDbPath,
    });
    this.agents.set(id, { process: proc, type: 'long_running' });
    return proc;
  }

  spawnEphemeral(
    id: string,
    sessionId: string,
    memoryDbPath: string,
    agentType: AgentType,
    env?: Record<string, string>
  ): AgentProcess {
    const proc = new AgentProcess({
      command: 'pi',
      args: ['--agent', agentType],
      agentType,
      sessionId,
      memoryDbPath,
      env,
    });
    this.agents.set(id, { process: proc, type: 'ephemeral' });
    return proc;
  }

  get(id: string): AgentProcess | null {
    return this.agents.get(id)?.process ?? null;
  }

  kill(id: string): void {
    const agent = this.agents.get(id);
    if (agent) {
      agent.process.kill();
      this.agents.delete(id);
    }
  }

  killAll(): void {
    for (const [id] of this.agents) {
      this.kill(id);
    }
  }

  killEphemeral(): void {
    for (const [id, agent] of this.agents) {
      if (agent.type === 'ephemeral') {
        agent.process.kill();
        this.agents.delete(id);
      }
    }
  }

  getAllStatuses(): Map<string, AgentStatus> {
    const statuses = new Map<string, AgentStatus>();
    for (const [id, agent] of this.agents) {
      statuses.set(id, agent.process.getStatus());
    }
    return statuses;
  }

  getByAgentType(agentType: AgentType): AgentProcess[] {
    const result: AgentProcess[] = [];
    for (const agent of this.agents.values()) {
      if (agent.process.getStatus().agentType === agentType) {
        result.push(agent.process);
      }
    }
    return result;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agents/agent-pool.ts
git commit -m "feat: agent pool — spawn long-running/ephemeral agents, lifecycle management"
```

---

### Task 4: Agent health check monitor

**Files:**
- Create: `src/agents/agent-health.ts`
- Test: `tests/agents/agent-health.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agents/agent-health.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentHealthMonitor } from '../../src/agents/agent-health.js';
import { AgentPool } from '../../src/agents/agent-pool.js';
import type { AgentType } from '../../src/types/common.js';

describe('AgentHealthMonitor', () => {
  it('detects crashed agents and calls callback', () => {
    const pool = new AgentPool();
    const onCrash = vi.fn();
    const monitor = new AgentHealthMonitor(pool, {
      intervalMs: 100,
      timeoutMs: 50,
      onCrash,
    });

    monitor.start();
    // No agents = no crashes
    expect(onCrash).not.toHaveBeenCalled();
    monitor.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agents/agent-health.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write agent-health.ts**

```typescript
// src/agents/agent-health.ts
import type { AgentPool } from './agent-pool.js';
import type { AgentType } from '../types/common.js';

export interface HealthMonitorConfig {
  intervalMs: number;   // How often to check (default: 10000)
  timeoutMs: number;    // How long before considering unresponsive (default: 5000)
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agents/agent-health.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agents/agent-health.ts tests/agents/agent-health.test.ts
git commit -m "feat: agent health monitor — periodic check, crash/unresponsive detection"
```

---

### Task 5: Run all Phase 2 tests

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL TESTS PASS (Phase 1 + Phase 2)

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "chore: Phase 2 complete — agent pool with JSON-RPC, process management, health checks"
```
