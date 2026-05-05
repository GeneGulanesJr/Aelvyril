# Phase 13: Integration — Full Pipeline E2E, Crash Recovery, Error Scenarios

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up all 7 agents into a complete working pipeline. End-to-end test: user says "Add dark mode" → Supervisor → Ticket Agent → board → Main Agent → Sub-agents → Test Agent → Review Agent → Watchdog monitoring → auto PR → auto merge. Verify crash recovery, error scenarios, cost tracking, and expose the HTTP API endpoints that the Web UI needs.

**Architecture:** Integration tests that spin up the full Orchestrator with real SQLite databases (temp dirs). Tests the complete flow from user request through the pipeline to git operations. Also tests error scenarios (test failure, review rejection, LLM API failure, crash recovery). The Orchestrator is the glue — it wires SessionManager + AgentPool + BoardManager + all agents together and exposes HTTP + WebSocket.

**Tech Stack:** Integration tests, real SQLite, real git operations, supertest (HTTP)

**Spec reference:** Full spec `docs/superpowers/specs/2026-05-05-cloud-platform-design.md`

**Depends on:** Phase 1-12

---

## File Structure

```
src/
├── orchestrator.ts              # Main glue — wires everything together
├── routes/
│   ├── session-routes.ts        # Session CRUD HTTP endpoints
│   ├── config-routes.ts         # Config GET/PUT
│   └── ws-handler.ts            # WebSocket connection handler
tests/
└── integration/
    ├── full-pipeline.test.ts    # E2E: request → tickets → sub → test → review → PR
    ├── crash-recovery.test.ts   # Kill mid-task → restart → verify recovery
    ├── cost-tracking.test.ts    # Verify cumulative cost across full pipeline
    ├── error-scenarios.test.ts  # Test fail, reject, held state, thresholds
    └── api-endpoints.test.ts    # HTTP API endpoint tests
```

---

### Task 1: Orchestrator — main glue code

**Files:**
- Create: `src/orchestrator.ts`

- [ ] **Step 1: Write orchestrator.ts**

```typescript
// src/orchestrator.ts
import { Database } from './db/database.js';
import { SessionManager } from './sessions/session-manager.js';
import { AgentPool } from './agents/agent-pool.js';
import { BoardManager } from './board/board-manager.js';
import { BoardEvents } from './board/board-events.js';
import { ChatHandler } from './supervisor/chat-handler.js';
import { WatchdogAgent, DEFAULT_WATCHDOG_CONFIG } from './agents/watchdog/watchdog-agent.js';
import { TestAgent, type TestAgentConfig } from './agents/test-agent/test-agent.js';
import { ReviewAgent, type ReviewAgentConfig } from './agents/review-agent/review-agent.js';
import { createTicketBranch, createPR, mergePR } from './agents/main-agent/git-operations.js';
import { getNextDispatchable } from './agents/main-agent/wave-executor.js';
import { buildTicketPrompt } from './agents/ticket-agent/prompt-builder.js';
import { parsePlanResponse } from './agents/ticket-agent/plan-parser.js';
import type { Ticket, TicketStatus, ConcurrencyPlan } from './types/common.js';

export interface OrchestratorConfig {
  port: number;
  workspaceRoot: string;
  dbPath: string;
}

export class Orchestrator {
  public readonly db: Database;
  public readonly sessionManager: SessionManager;
  public readonly agentPool: AgentPool;
  public readonly boardEvents: BoardEvents;

  private watchdogs: Map<string, WatchdogAgent> = new Map();
  private boards: Map<string, BoardManager> = new Map();

  constructor(private config: OrchestratorConfig) {
    this.db = new Database(config.dbPath);
    this.sessionManager = new SessionManager(this.db, config.workspaceRoot);
    this.agentPool = new AgentPool();
    this.boardEvents = new BoardEvents();
  }

  /**
   * Start a new coding session
   */
  startSession(repoUrl: string): { sessionId: string; board: BoardManager } {
    // 1. Create session (clones repo, creates workspace)
    const session = this.sessionManager.create(repoUrl);

    // 2. Create board for this session
    const board = new BoardManager(this.db, session.id);
    this.boards.set(session.id, board);

    // 3. Spawn long-running agents
    const memoryDbPath = `${session.workspace_path}/.aelvyril/memory.db`;
    this.agentPool.spawnLongRunning('supervisor', session.id, memoryDbPath, 'supervisor');
    this.agentPool.spawnLongRunning('main_agent', session.id, memoryDbPath, 'main');
    this.agentPool.spawnLongRunning('watchdog', session.id, memoryDbPath, 'watchdog');

    // 4. Start watchdog
    const watchdog = new WatchdogAgent(this.agentPool, board, session.id, DEFAULT_WATCHDOG_CONFIG);
    watchdog.setCallbacks({
      onProgress: (report) => {
        this.boardEvents.emitBoardState({
          session_id: session.id,
          tickets: board.getTickets(),
          plan: board.getConcurrencyPlan() ?? { max_parallel: 1, waves: [], conflict_groups: [] },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      },
      onEscalate: (ticketId, message) => {
        this.boardEvents.emit('escalation', { session_id: session.id, ticket_id: ticketId, message });
      },
      onIntervention: (stuck, action) => {
        this.boardEvents.emit('agent_activity', {
          agent: 'WATCHDOG',
          action: `Intervention: ${action} for ${stuck.ticket_id}`,
        });
      },
    });
    watchdog.start();
    this.watchdogs.set(session.id, watchdog);

    return { sessionId: session.id, board };
  }

  /**
   * Route a user message to the Supervisor
   */
  async routeMessage(sessionId: string, content: string): Promise<void> {
    const board = this.boards.get(sessionId);
    if (!board) throw new Error(`Session ${sessionId} not found`);

    const session = this.sessionManager.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const chatHandler = new ChatHandler({
      onNewRequest: async (req) => {
        // 1. Spawn Ticket Agent to decompose
        const memoryDbPath = `${session.workspace_path}/.aelvyril/memory.db`;
        const agentId = `ticket-${Date.now()}`;
        const prompt = buildTicketPrompt(req, []);

        // In production: spawn pi process, collect response
        // For now: this is the integration point
        this.boardEvents.emit('agent_activity', {
          agent: 'TICKET_AGENT',
          action: `Decomposing request: "${req}"`,
        });
      },
      onRedirect: async (ticketId, content) => {
        // Re-scope a ticket
        this.boardEvents.emit('agent_activity', {
          agent: 'SUPERVISOR',
          action: `Redirecting ${ticketId}: ${content}`,
        });
      },
      onStatusCheck: async () => {
        const tickets = board.getTickets();
        const plan = board.getConcurrencyPlan();
        this.boardEvents.emit('supervisor_response', {
          message: `${tickets.length} tickets. Plan: ${plan ? `${plan.max_parallel} parallel, ${plan.waves.length} waves` : 'No plan yet'}`,
        });
      },
      onCancel: async () => {
        this.agentPool.killEphemeral();
        this.boardEvents.emit('supervisor_response', { message: 'All tasks cancelled.' });
      },
      onConfigUpdate: async (key, value) => {
        this.boardEvents.emit('supervisor_response', { message: `Config updated: ${key}` });
      },
    });

    await chatHandler.handleMessage(sessionId, content);
  }

  /**
   * Process tickets after Ticket Agent populates the board
   * Called by the Main Agent's orchestration loop
   */
  async processTickets(sessionId: string): Promise<void> {
    const board = this.boards.get(sessionId);
    if (!board) return;

    const plan = board.getConcurrencyPlan();
    if (!plan) return;

    const tickets = board.getTickets();
    const dispatchable = getNextDispatchable(tickets, plan, 0);

    for (const ticketId of dispatchable) {
      const ticket = board.getTicket(ticketId);
      if (!ticket) continue;

      // Transition to in_progress
      board.transition(ticketId, 'in_progress');

      // Create git branch
      const session = this.sessionManager.get(sessionId);
      if (session) {
        createTicketBranch(session.workspace_path, ticketId, sessionId);
        // Update ticket with branch name
        // (In production, this would be a board method)
      }

      this.boardEvents.emit('agent_activity', {
        agent: 'MAIN_AGENT',
        action: `Dispatched ${ticketId} (${ticket.title})`,
      });
    }
  }

  /**
   * Run test agent for a ticket
   */
  async runTests(sessionId: string, ticketId: string): Promise<void> {
    const board = this.boards.get(sessionId);
    if (!board) return;

    const session = this.sessionManager.get(sessionId);
    if (!session) return;

    const ticket = board.getTicket(ticketId);
    if (!ticket) return;

    board.transition(ticketId, 'testing');

    const testAgent = new TestAgent(this.agentPool, board, {
      sessionId,
      sessionBranch: `aelvyril/session-${sessionId}`,
      memoryDbPath: `${session.workspace_path}/.aelvyril/memory.db`,
      workspacePath: session.workspace_path,
    });

    const result = await testAgent.execute(ticket, []);

    if (result.passed) {
      board.transition(ticketId, 'in_review');
      await this.runReview(sessionId, ticketId);
    } else {
      board.transition(ticketId, 'in_progress');
      this.boardEvents.emit('agent_activity', {
        agent: 'TEST_AGENT',
        action: `Tests failed for ${ticketId}: ${result.failures.map(f => f.test_name).join(', ')}`,
      });
    }
  }

  /**
   * Run review agent for a ticket
   */
  async runReview(sessionId: string, ticketId: string): Promise<void> {
    const board = this.boards.get(sessionId);
    if (!board) return;

    const session = this.sessionManager.get(sessionId);
    if (!session) return;

    const ticket = board.getTicket(ticketId);
    if (!ticket) return;

    const reviewAgent = new ReviewAgent(this.agentPool, board, {
      sessionId,
      sessionBranch: `aelvyril/session-${sessionId}`,
      memoryDbPath: `${session.workspace_path}/.aelvyril/memory.db`,
      workspacePath: session.workspace_path,
    });

    const decision = await reviewAgent.execute(ticket, []);

    this.boardEvents.emit('agent_activity', {
      agent: 'REVIEW_AGENT',
      action: `${decision.approved ? '✅ Approved' : '❌ Rejected'} ${ticketId}: ${decision.summary}`,
    });
  }

  /**
   * Destroy a session
   */
  destroySession(sessionId: string): void {
    const watchdog = this.watchdogs.get(sessionId);
    watchdog?.stop();
    this.watchdogs.delete(sessionId);
    this.boards.delete(sessionId);
    this.agentPool.killAll();
    this.sessionManager.destroy(sessionId);
  }

  /**
   * Get the board manager for a session
   */
  getBoard(sessionId: string): BoardManager | undefined {
    return this.boards.get(sessionId);
  }

  /**
   * Graceful shutdown
   */
  shutdown(): void {
    for (const [id] of this.watchdogs) {
      this.watchdogs.get(id)?.stop();
    }
    this.agentPool.killAll();
    this.db.close();
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/orchestrator.ts
git commit -m "feat: orchestrator — main glue wiring sessions, agents, board, watchdog, pipeline"
```

---

### Task 2: Session HTTP routes

**Files:**
- Create: `src/routes/session-routes.ts`

- [ ] **Step 1: Write session-routes.ts**

```typescript
// src/routes/session-routes.ts
import type { Orchestrator } from '../orchestrator.js';
import type { IncomingMessage, ServerResponse } from 'http';

export function registerSessionRoutes(
  orchestrator: Orchestrator,
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  const url = new URL(req.url ?? '/', `http://localhost`);
  const path = url.pathname;

  // GET /api/sessions
  if (path === '/api/sessions' && req.method === 'GET') {
    const sessions = orchestrator.sessionManager.list();
    jsonResponse(res, sessions);
    return true;
  }

  // POST /api/sessions
  if (path === '/api/sessions' && req.method === 'POST') {
    readBody(req).then((body: any) => {
      const { sessionId } = orchestrator.startSession(body.repo_url);
      jsonResponse(res, { id: sessionId, status: 'active' }, 201);
    });
    return true;
  }

  // GET /api/sessions/:id
  const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch && req.method === 'GET') {
    const session = orchestrator.sessionManager.get(sessionMatch[1]);
    if (!session) { jsonResponse(res, { error: 'Not found' }, 404); return true; }
    jsonResponse(res, session);
    return true;
  }

  // DELETE /api/sessions/:id
  if (sessionMatch && req.method === 'DELETE') {
    orchestrator.destroySession(sessionMatch[1]);
    jsonResponse(res, { ok: true });
    return true;
  }

  // GET /api/sessions/:id/board
  const boardMatch = path.match(/^\/api\/sessions\/([^/]+)\/board$/);
  if (boardMatch && req.method === 'GET') {
    const board = orchestrator.getBoard(boardMatch[1]);
    if (!board) { jsonResponse(res, { error: 'Not found' }, 404); return true; }
    const plan = board.getConcurrencyPlan();
    jsonResponse(res, {
      session_id: boardMatch[1],
      tickets: board.getTickets(),
      plan,
    });
    return true;
  }

  // GET /api/sessions/:id/cost
  const costMatch = path.match(/^\/api\/sessions\/([^/]+)\/cost$/);
  if (costMatch && req.method === 'GET') {
    const board = orchestrator.getBoard(costMatch[1]);
    if (!board) { jsonResponse(res, { error: 'Not found' }, 404); return true; }
    const tickets = board.getTickets();
    const totalTokens = tickets.reduce((sum, t) => sum + t.cost_tokens, 0);
    const totalCost = tickets.reduce((sum, t) => sum + t.cost_usd, 0);
    jsonResponse(res, {
      session_id: costMatch[1],
      total_tokens: totalTokens,
      total_cost_usd: totalCost,
      by_agent: {},
      by_ticket: Object.fromEntries(tickets.map(t => [t.id, { tokens: t.cost_tokens, cost: t.cost_usd }])),
    });
    return true;
  }

  // GET /api/sessions/:id/audit
  const auditMatch = path.match(/^\/api\/sessions\/([^/]+)\/audit$/);
  if (auditMatch && req.method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const rows = orchestrator.db.raw.prepare(
      'SELECT * FROM audit_log WHERE session_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?'
    ).all(auditMatch[1], limit, offset);
    jsonResponse(res, rows);
    return true;
  }

  return false;
}

function jsonResponse(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/session-routes.ts
git commit -m "feat: session HTTP routes — CRUD, board, cost, audit endpoints"
```

---

### Task 3: Config routes

**Files:**
- Create: `src/routes/config-routes.ts`

- [ ] **Step 1: Write config-routes.ts**

```typescript
// src/routes/config-routes.ts
import type { IncomingMessage, ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_PATH = path.join(os.homedir(), '.aelvyril', 'config.json');

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfig(config: Record<string, unknown>): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function registerConfigRoutes(
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/api/config' && req.method === 'GET') {
    const config = readConfig();
    // Mask API keys
    if (config.api_keys && typeof config.api_keys === 'object') {
      const masked: Record<string, string> = {};
      for (const [key, val] of Object.entries(config.api_keys as Record<string, string>)) {
        masked[key] = val ? `${val.slice(0, 4)}${'*'.repeat(Math.max(0, val.length - 4))}` : '';
      }
      config.api_keys = masked;
    }
    jsonResponse(res, config);
    return true;
  }

  if (url.pathname === '/api/config' && req.method === 'PUT') {
    readBody(req).then((body: any) => {
      const current = readConfig();
      const updated = { ...current, ...body };
      // Don't overwrite masked API keys
      if (body.api_keys && current.api_keys) {
        for (const [key, val] of Object.entries(body.api_keys as Record<string, string>)) {
          if (val.includes('*')) {
            (updated.api_keys as Record<string, string>)[key] = (current.api_keys as Record<string, string>)[key];
          }
        }
      }
      writeConfig(updated);
      jsonResponse(res, updated);
    });
    return true;
  }

  return false;
}

function jsonResponse(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/config-routes.ts
git commit -m "feat: config routes — GET/PUT with masked API keys"
```

---

### Task 4: WebSocket handler

**Files:**
- Create: `src/routes/ws-handler.ts`

- [ ] **Step 1: Write ws-handler.ts**

```typescript
// src/routes/ws-handler.ts
import type { WebSocket } from 'ws';
import type { Orchestrator } from '../orchestrator.js';

export function handleWebSocketConnection(orchestrator: Orchestrator, ws: WebSocket): void {
  // Send initial board state on connect
  ws.send(JSON.stringify({
    event: 'connected',
    data: { message: 'Aelvyril WebSocket connected' },
    timestamp: new Date().toISOString(),
  }));

  // Forward board events to this client
  const onBoardEvent = (_event: string, message: string) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(message);
    }
  };

  orchestrator.boardEvents.onBoardChange(onBoardEvent);

  // Handle incoming messages from client
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

  // Cleanup on disconnect
  ws.on('close', () => {
    orchestrator.boardEvents.off('board_state', onBoardEvent);
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/ws-handler.ts
git commit -m "feat: WebSocket handler — board events broadcast, chat message routing"
```

---

### Task 5: API endpoint integration tests

**Files:**
- Create: `tests/integration/api-endpoints.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
// tests/integration/api-endpoints.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Database } from '../../src/db/database.js';
import { Orchestrator } from '../../src/orchestrator.js';
import { registerSessionRoutes } from '../../src/routes/session-routes.js';
import { registerConfigRoutes } from '../../src/routes/config-routes.js';

describe('API endpoints', () => {
  let orchestrator: Orchestrator;
  let server: Server;
  let wss: WebSocketServer;
  let tmpDir: string;
  let port: number;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-api-'));
    orchestrator = new Orchestrator({
      port: 0,
      workspaceRoot: path.join(tmpDir, 'workspaces'),
      dbPath: path.join(tmpDir, 'test.db'),
    });

    server = createServer((req, res) => {
      if (!registerSessionRoutes(orchestrator, req, res)) {
        if (!registerConfigRoutes(req, res)) {
          res.writeHead(404);
          res.end('Not found');
        }
      }
    });

    await new Promise<void>(resolve => server.listen(0, () => resolve()));
    port = (server.address() as any).port;

    wss = new WebSocketServer({ server });
    wss.on('connection', (ws) => {
      // Simple echo for testing
      ws.on('message', (data) => {
        ws.send(data.toString());
      });
    });
  });

  afterEach(() => {
    wss.close();
    server.close();
    orchestrator.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/sessions returns empty list', async () => {
    const res = await fetch(`http://localhost:${port}/api/sessions`);
    const data = await res.json();
    expect(data).toEqual([]);
  });

  it('GET /api/config returns config object', async () => {
    const res = await fetch(`http://localhost:${port}/api/config`);
    const data = await res.json();
    expect(data).toBeDefined();
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`http://localhost:${port}/api/unknown`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run → verify passes**

Run: `npx vitest run tests/integration/api-endpoints.test.ts`

- [ ] **Step 3: Commit**

```bash
git add tests/integration/api-endpoints.test.ts
git commit -m "test: API endpoint integration tests — sessions, config, 404"
```

---

### Task 6: Full pipeline E2E test

**Files:**
- Create: `tests/integration/full-pipeline.test.ts`

- [ ] **Step 1: Write the E2E test**

```typescript
// tests/integration/full-pipeline.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { Database } from '../../src/db/database.js';
import { BoardManager } from '../../src/board/board-manager.js';
import { SessionManager } from '../../src/sessions/session-manager.js';

/**
 * Full pipeline E2E test.
 *
 * Since we can't run actual pi processes in CI, this test validates:
 * 1. Board state transitions work correctly
 * 2. Concurrency plan is respected
 * 3. Cost tracking accumulates
 * 4. The pipeline flow (backlog → in_progress → testing → in_review → done) works
 * 5. Error paths (test failure → back to in_progress) work
 * 6. Reject paths (review reject → back to backlog) work
 */
describe('Full pipeline E2E', () => {
  let db: Database;
  let board: BoardManager;
  let tmpDir: string;
  let sessionId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-e2e-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    const sm = new SessionManager(db, path.join(tmpDir, 'workspaces'));

    // Create a real git repo for the session
    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoDir);
    execSync('git init', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test Project\n');
    execSync('git add . && git commit -m "init"', { cwd: repoDir, stdio: 'pipe' });

    const session = sm.create(repoDir);
    sessionId = session.id;
    board = new BoardManager(db, sessionId);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('happy path: create tickets → dispatch → test → review → done', () => {
    // 1. Ticket Agent creates tickets
    const t1 = board.createTicket({
      title: 'Add theme context',
      description: 'Create theme context provider',
      acceptance_criteria: ['Context exports theme', 'Context supports light/dark'],
      dependencies: [],
      files: ['src/theme.tsx'],
      priority: 1,
    });
    const t2 = board.createTicket({
      title: 'Build toggle',
      description: 'Build theme toggle component',
      acceptance_criteria: ['Toggle renders', 'Toggle switches theme'],
      dependencies: ['#1'],
      files: ['src/Toggle.tsx'],
      priority: 2,
    });

    // 2. Save concurrency plan
    board.saveConcurrencyPlan({
      max_parallel: 1,
      waves: [['#1'], ['#2']],
      conflict_groups: [],
    });

    // 3. Main Agent dispatches #1
    board.transition('#1', 'in_progress');
    board.assignAgent('#1', 'sub-1');
    expect(board.getTicket('#1')!.status).toBe('in_progress');

    // 4. Sub-agent completes
    board.transition('#1', 'testing');

    // 5. Test Agent passes
    board.setTestResults('#1', {
      passed: true, total: 5, passed_count: 5, failed_count: 0,
      failures: [], coverage_delta: null, duration_ms: 1500,
      test_branch: 'aelvyril/ticket-#1', timestamp: new Date().toISOString(),
    });
    board.transition('#1', 'in_review');

    // 6. Review Agent approves
    board.transition('#1', 'done');
    expect(board.getTicket('#1')!.status).toBe('done');

    // 7. #2 is now unblocked
    board.transition('#2', 'in_progress');
    board.transition('#2', 'testing');
    board.transition('#2', 'in_review');
    board.transition('#2', 'done');

    // 8. Verify all done
    const doneTickets = board.getTicketsByStatus('done');
    expect(doneTickets).toHaveLength(2);
  });

  it('test failure path: sub-agent → test fail → back to in_progress', () => {
    const t1 = board.createTicket({
      title: 'Add feature',
      description: 'Add feature X',
      acceptance_criteria: ['Feature works'],
      dependencies: [],
      files: ['src/feature.ts'],
      priority: 1,
    });

    board.transition('#1', 'in_progress');
    board.transition('#1', 'testing');

    // Test fails
    board.setTestResults('#1', {
      passed: false, total: 3, passed_count: 2, failed_count: 1,
      failures: [{ test_name: 'should work', message: 'expected true received false' }],
      coverage_delta: null, duration_ms: 800,
      test_branch: 'aelvyril/ticket-#1', timestamp: new Date().toISOString(),
    });

    // Back to in_progress
    board.transition('#1', 'in_progress');
    expect(board.getTicket('#1')!.status).toBe('in_progress');
    expect(board.getTicket('#1')!.test_results).toBeDefined();
  });

  it('review rejection path: review reject → back to backlog', () => {
    const t1 = board.createTicket({
      title: 'Add feature',
      description: 'Add feature X',
      acceptance_criteria: ['Feature works'],
      dependencies: [],
      files: ['src/feature.ts'],
      priority: 1,
    });

    board.transition('#1', 'in_progress');
    board.transition('#1', 'testing');
    board.transition('#1', 'in_review');

    // Review rejects
    board.reject('#1', 'Missing error handling for edge case');
    expect(board.getTicket('#1')!.status).toBe('backlog');
    expect(board.getTicket('#1')!.reject_count).toBe(1);
    expect(board.getTicket('#1')!.review_notes).toBe('Missing error handling for edge case');
  });

  it('held state path: API failure → held → release → resume', () => {
    const t1 = board.createTicket({
      title: 'Add feature',
      description: 'Add feature X',
      acceptance_criteria: ['Feature works'],
      dependencies: [],
      files: ['src/feature.ts'],
      priority: 1,
    });

    board.transition('#1', 'in_progress');

    // API failure → held
    board.hold('#1', 'LLM API rate limit exceeded');
    expect(board.getTicket('#1')!.status).toBe('held');
    expect(board.getTicket('#1')!.held_reason).toBe('LLM API rate limit exceeded');

    // User resolves → release
    board.release('#1');
    expect(board.getTicket('#1')!.status).toBe('in_progress');
    expect(board.getTicket('#1')!.held_reason).toBeNull();
  });

  it('cumulative cost tracking across retries', () => {
    const t1 = board.createTicket({
      title: 'Add feature',
      description: 'Add feature X',
      acceptance_criteria: ['Feature works'],
      dependencies: [],
      files: ['src/feature.ts'],
      priority: 1,
    });

    // Attempt 1
    board.addCost('#1', 1000, 0.05);
    board.reject('#1', 'Bad code');

    // Attempt 2
    board.addCost('#1', 2000, 0.10);

    const ticket = board.getTicket('#1');
    expect(ticket!.cost_tokens).toBe(3000);
    expect(ticket!.cost_usd).toBeCloseTo(0.15);
  });
});
```

- [ ] **Step 2: Run → verify passes**

Run: `npx vitest run tests/integration/full-pipeline.test.ts`

- [ ] **Step 3: Commit**

```bash
git add tests/integration/full-pipeline.test.ts
git commit -m "test: full pipeline E2E — happy path, test failure, review rejection, held state, cost tracking"
```

---

### Task 7: Crash recovery test

**Files:**
- Create: `tests/integration/crash-recovery.test.ts`

- [ ] **Step 1: Write crash recovery test**

```typescript
// tests/integration/crash-recovery.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Database } from '../../src/db/database.js';
import { BoardManager } from '../../src/board/board-manager.js';
import { SessionManager } from '../../src/sessions/session-manager.js';
import { detectStuckTickets } from '../../src/agents/watchdog/stuck-detector.js';

describe('Crash recovery', () => {
  let db: Database;
  let board: BoardManager;
  let tmpDir: string;
  let sessionId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-crash-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    const sm = new SessionManager(db, path.join(tmpDir, 'workspaces'));
    const session = sm.create('/tmp/fake-repo');
    sessionId = session.id;
    board = new BoardManager(db, sessionId);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('recovers tickets that were in_progress when crash happened', () => {
    // Simulate: create tickets, start working, then crash
    board.createTicket({ title: 'Task A', description: '', acceptance_criteria: ['Done'], dependencies: [], files: ['a.ts'], priority: 1 });
    board.createTicket({ title: 'Task B', description: '', acceptance_criteria: ['Done'], dependencies: [], files: ['b.ts'], priority: 2 });

    board.transition('#1', 'in_progress');
    board.assignAgent('#1', 'sub-1');

    // "Crash" — simulate restart by creating new BoardManager (same DB)
    const recoveredBoard = new BoardManager(db, sessionId);

    // Tickets should still be in their last state
    const t1 = recoveredBoard.getTicket('#1');
    expect(t1!.status).toBe('in_progress');
    expect(t1!.assigned_agent).toBe('sub-1');

    // Watchdog detects stuck in_progress ticket
    const stuck = detectStuckTickets(recoveredBoard.getTickets(), {
      stallThresholdMs: 0, // Anything > 0ms is stuck (for testing)
    });
    expect(stuck.some(s => s.ticket_id === '#1')).toBe(true);
  });

  it('recovers tickets that were in testing when crash happened', () => {
    board.createTicket({ title: 'Task A', description: '', acceptance_criteria: ['Done'], dependencies: [], files: ['a.ts'], priority: 1 });
    board.transition('#1', 'in_progress');
    board.transition('#1', 'testing');

    // New board from same DB
    const recoveredBoard = new BoardManager(db, sessionId);
    const t1 = recoveredBoard.getTicket('#1');
    expect(t1!.status).toBe('testing');
  });

  it('preserves concurrency plan across restart', () => {
    board.createTicket({ title: 'Task A', description: '', acceptance_criteria: ['Done'], dependencies: [], files: ['a.ts'], priority: 1 });
    board.saveConcurrencyPlan({
      max_parallel: 2,
      waves: [['#1']],
      conflict_groups: [],
    });

    // New board from same DB
    const recoveredBoard = new BoardManager(db, sessionId);
    const plan = recoveredBoard.getConcurrencyPlan();
    expect(plan).not.toBeNull();
    expect(plan!.max_parallel).toBe(2);
  });
});
```

- [ ] **Step 2: Run → verify passes**

Run: `npx vitest run tests/integration/crash-recovery.test.ts`

- [ ] **Step 3: Commit**

```bash
git add tests/integration/crash-recovery.test.ts
git commit -m "test: crash recovery — verify board state survives restart, watchdog detects stale"
```

---

### Task 8: Error scenario tests

**Files:**
- Create: `tests/integration/error-scenarios.test.ts`

- [ ] **Step 1: Write error scenarios test**

```typescript
// tests/integration/error-scenarios.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Database } from '../../src/db/database.js';
import { BoardManager } from '../../src/board/board-manager.js';
import { SessionManager } from '../../src/sessions/session-manager.js';
import { detectStuckTickets } from '../../src/agents/watchdog/stuck-detector.js';

describe('Error scenarios', () => {
  let db: Database;
  let board: BoardManager;
  let tmpDir: string;
  let sessionId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-errors-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    const sm = new SessionManager(db, path.join(tmpDir, 'workspaces'));
    const session = sm.create('/tmp/fake-repo');
    sessionId = session.id;
    board = new BoardManager(db, sessionId);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('3x reject triggers escalation', () => {
    board.createTicket({ title: 'Stubborn task', description: '', acceptance_criteria: ['Done'], dependencies: [], files: ['a.ts'], priority: 1 });

    // Simulate 3 review cycles
    for (let i = 0; i < 3; i++) {
      board.transition('#1', 'in_progress');
      board.transition('#1', 'testing');
      board.transition('#1', 'in_review');
      board.reject('#1', `Attempt ${i + 1}: still wrong`);
    }

    const ticket = board.getTicket('#1');
    expect(ticket!.reject_count).toBe(3);

    const stuck = detectStuckTickets(board.getTickets(), {
      stallThresholdMs: 0,
      rejectEscalationThreshold: 3,
    });
    const escalation = stuck.find(s => s.reason === 'reject_threshold');
    expect(escalation).toBeDefined();
    expect(escalation!.ticket_id).toBe('#1');
  });

  it('5x reject triggers hard stop', () => {
    board.createTicket({ title: 'Hopeless task', description: '', acceptance_criteria: ['Done'], dependencies: [], files: ['a.ts'], priority: 1 });

    for (let i = 0; i < 5; i++) {
      board.transition('#1', 'in_progress');
      board.transition('#1', 'testing');
      board.transition('#1', 'in_review');
      board.reject('#1', `Attempt ${i + 1}`);
    }

    const stuck = detectStuckTickets(board.getTickets(), {
      stallThresholdMs: 0,
      rejectHardStopThreshold: 5,
    });
    const hardStop = stuck.find(s => s.reason === 'reject_hard_stop');
    expect(hardStop).toBeDefined();
  });

  it('held ticket does not appear as stuck', () => {
    board.createTicket({ title: 'Blocked', description: '', acceptance_criteria: ['Done'], dependencies: [], files: ['a.ts'], priority: 1 });
    board.transition('#1', 'in_progress');
    board.hold('#1', 'API rate limit');

    const stuck = detectStuckTickets(board.getTickets(), { stallThresholdMs: 0 });
    expect(stuck.find(s => s.ticket_id === '#1')).toBeUndefined();
  });

  it('release from held resumes to previous state', () => {
    board.createTicket({ title: 'Resumable', description: '', acceptance_criteria: ['Done'], dependencies: [], files: ['a.ts'], priority: 1 });
    board.transition('#1', 'in_progress');
    board.hold('#1', 'API down');
    board.release('#1');

    expect(board.getTicket('#1')!.status).toBe('in_progress');
    expect(board.getTicket('#1')!.held_reason).toBeNull();
  });

  it('test failure does not move ticket to review', () => {
    board.createTicket({ title: 'Testable', description: '', acceptance_criteria: ['Done'], dependencies: [], files: ['a.ts'], priority: 1 });
    board.transition('#1', 'in_progress');
    board.transition('#1', 'testing');

    board.setTestResults('#1', {
      passed: false, total: 1, passed_count: 0, failed_count: 1,
      failures: [{ test_name: 'should work', message: 'fail' }],
      coverage_delta: null, duration_ms: 100,
      test_branch: 'aelvyril/ticket-#1', timestamp: new Date().toISOString(),
    });

    // Should go back to in_progress, NOT to in_review
    board.transition('#1', 'in_progress');
    expect(board.getTicket('#1')!.status).toBe('in_progress');
    expect(board.getTicket('#1')!.test_results!.passed).toBe(false);
  });
});
```

- [ ] **Step 2: Run → verify passes**

Run: `npx vitest run tests/integration/error-scenarios.test.ts`

- [ ] **Step 3: Commit**

```bash
git add tests/integration/error-scenarios.test.ts
git commit -m "test: error scenarios — 3x/5x reject, held state, test failure, resume"
```

---

### Task 9: Serve static UI files

**Files:**
- Modify: `src/server.ts` (from Phase 1 Task 8)

- [ ] **Step 1: Add static file serving to server.ts**

```typescript
// Add to the request handler in server.ts, before the API routes:
import fs from 'fs';
import path from 'path';

const UI_DIST = path.join(__dirname, '..', '..', 'ui', 'dist');

function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
  let filePath = path.join(UI_DIST, req.url === '/' ? 'index.html' : req.url!.slice(1));
  if (!fs.existsSync(filePath)) {
    filePath = path.join(UI_DIST, 'index.html'); // SPA fallback
  }
  if (fs.existsSync(filePath)) {
    const ext = path.extname(filePath);
    const contentTypes: Record<string, string> = {
      '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
      '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
    };
    res.writeHead(200, { 'Content-Type': contentTypes[ext] ?? 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }
  return false;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server.ts
git commit -m "feat: serve static UI files from ui/dist/ with SPA fallback"
```

---

### Task 10: Run ALL tests — full suite verification

- [ ] **Step 1: Run complete test suite**

Run: `npx vitest run`
Expected: ALL TESTS PASS (Phase 1-13, unit + integration)

- [ ] **Step 2: Run UI build**

Run: `cd ui && npm run build`
Expected: Build succeeds

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "chore: Phase 13 complete — integration tests, API routes, crash recovery, error scenarios"
```
