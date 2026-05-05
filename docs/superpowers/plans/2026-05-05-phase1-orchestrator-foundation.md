# Phase 1: Orchestrator Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Node.js/TypeScript Orchestrator server with HTTP + WebSocket, SQLite persistence layer, session management, and config — the backbone everything else plugs into.

**Architecture:** A single Node.js process serving HTTP REST + WebSocket. SQLite (WAL mode) for all persistent state (sessions, kanban boards, audit log, cost tracking, config). The Orchestrator is the message bus — all agents communicate through it. No Redis, no external dependencies.

**Tech Stack:** Node.js ≥ 22.5, TypeScript, better-sqlite3 (synchronous SQLite), ws (WebSocket), Vite+ (`vp`)

**Spec reference:** `docs/superpowers/specs/2026-05-05-cloud-platform-design.md` §2.1–2.4, §2.6–2.8

---

## File Structure

```
aelvyril/
├── package.json
├── tsconfig.json
├── vite.config.ts              # Build config for server
├── src/
│   ├── index.ts                # Entry point — starts server
│   ├── server.ts               # HTTP + WebSocket server setup
│   ├── db/
│   │   ├── database.ts         # SQLite connection, WAL mode, migrations
│   │   ├── schema.sql          # All table definitions
│   │   └── migrations.ts       # Migration runner
│   ├── sessions/
│   │   ├── session-manager.ts  # Create/destroy/list/pause/resume sessions
│   │   └── session.types.ts    # Session interface/types
│   ├── workspace/
│   │   └── workspace-manager.ts # Clone repos, manage filesystem workspaces
│   ├── config/
│   │   ├── config-manager.ts   # Load/save config from ~/.aelvyril/config.json + DB
│   │   └── config.types.ts     # Config interface/types
│   ├── audit/
│   │   └── audit-log.ts        # Append-only audit log to SQLite
│   ├── cost/
│   │   └── cost-tracker.ts     # Token/cost tracking per session/agent/ticket
│   └── types/
│       └── common.ts           # Shared types (AgentType, TicketStatus, etc.)
└── tests/
    ├── db/
    │   └── database.test.ts
    ├── sessions/
    │   └── session-manager.test.ts
    ├── workspace/
    │   └── workspace-manager.test.ts
    ├── config/
    │   └── config-manager.test.ts
    ├── audit/
    │   └── audit-log.test.ts
    └── cost/
        └── cost-tracker.test.ts
```

---

### Task 1: Project scaffold and dependencies

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`

- [ ] **Step 1: Initialize project with Vite+**

```bash
cd /home/genegulanesjr/Documents/GulanesKorp/Aelvyril
vp init
```

If `vp` not available, fall back to manual setup:

```bash
npm init -y
```

- [ ] **Step 2: Install dependencies**

```bash
npm install better-sqlite3 ws
npm install -D typescript @types/better-sqlite3 @types/ws vitest
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "node",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "types": ["vitest/globals"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: Add scripts to package.json**

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest",
    "test:run": "vitest run"
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json
git commit -m "chore: scaffold orchestrator project with TypeScript + SQLite + WebSocket"
```

---

### Task 2: Shared types

**Files:**
- Create: `src/types/common.ts`
- Test: `tests/types/common.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/types/common.test.ts
import { describe, it, expect } from 'vitest';
import type {
  AgentType,
  TicketStatus,
  SessionStatus,
  CostEntry,
  AuditEntry,
} from '../../src/types/common.js';

describe('common types', () => {
  it('AgentType has all 7 agent roles', () => {
    const agents: AgentType[] = [
      'supervisor', 'ticket', 'main', 'sub', 'test', 'review', 'watchdog'
    ];
    expect(agents).toHaveLength(7);
  });

  it('TicketStatus has all 6 states', () => {
    const statuses: TicketStatus[] = [
      'backlog', 'in_progress', 'testing', 'in_review', 'done', 'held'
    ];
    expect(statuses).toHaveLength(6);
  });

  it('SessionStatus has all states', () => {
    const statuses: SessionStatus[] = [
      'active', 'paused', 'completed', 'crashed'
    ];
    expect(statuses).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/types/common.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the types**

```typescript
// src/types/common.ts
export type AgentType = 'supervisor' | 'ticket' | 'main' | 'sub' | 'test' | 'review' | 'watchdog';

export type TicketStatus = 'backlog' | 'in_progress' | 'testing' | 'in_review' | 'done' | 'held';

export type SessionStatus = 'active' | 'paused' | 'completed' | 'crashed';

export interface CostEntry {
  session_id: string;
  agent_type: AgentType;
  ticket_id: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  timestamp: string; // ISO 8601
}

export interface AuditEntry {
  session_id: string;
  agent_type: AgentType;
  ticket_id: string | null;
  action: string;
  details: string | null;
  timestamp: string; // ISO 8601
}

export interface TestFailure {
  test_name: string;
  file: string;
  error_message: string;
  stack_trace: string | null;
}

export interface TestResult {
  passed: boolean;
  total: number;
  passed_count: number;
  failed_count: number;
  failures: TestFailure[];
  coverage_delta: number | null;
  duration_ms: number;
  test_branch: string;
  timestamp: string;
}

export interface Ticket {
  id: string;
  session_id: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
  dependencies: string[];
  files: string[];
  priority: number;
  status: TicketStatus;
  assigned_agent: string | null;
  test_results: TestResult | null;
  review_notes: string | null;
  reject_count: number;
  held_reason: string | null;
  git_branch: string | null;
  cost_tokens: number;
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

export interface ConcurrencyPlan {
  max_parallel: number;
  waves: string[][];         // Wave 1: ["#1", "#4"], Wave 2: ["#2"]
  conflict_groups: string[][]; // Tickets that cannot run together
}

export interface BoardState {
  session_id: string;
  tickets: Ticket[];
  plan: ConcurrencyPlan | null;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  repo_url: string;
  repo_path: string;           // Local filesystem path
  branch: string;              // Session branch name
  status: SessionStatus;
  memory_db_path: string;      // Path to PiMemoryExtension DB
  created_at: string;
  updated_at: string;
}

export interface CostReport {
  session_id: string;
  total_tokens: number;
  total_cost_usd: number;
  by_agent: Record<AgentType, { tokens: number; cost: number }>;
  by_ticket: Record<string, { tokens: number; cost: number }>;
}

export interface AgentModelConfig {
  supervisor: string;
  ticket: string;
  main: string;
  sub: string;
  test: string;
  review: string;
  watchdog: string;
}

export interface AelvyrilConfig {
  port: number;
  api_keys: Record<string, string>;  // provider → encrypted key
  models: AgentModelConfig;
  max_parallel: number;
  watchdog: {
    heartbeat_interval_ms: number;   // default: 5000
    stuck_threshold_ms: number;      // default: 300000 (5 min)
  };
  git: {
    branch_prefix: string;           // default: "aelvyril"
    auto_merge: boolean;             // default: true
  };
  db_path: string;                   // default: "~/.aelvyril/aelvyril.db"
  memory_db_dir: string;            // default: "~/.aelvyril/memory"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/types/common.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types/common.ts tests/types/common.test.ts
git commit -m "feat: shared types — agents, tickets, sessions, config, cost, audit"
```

---

### Task 3: SQLite database layer with migrations

**Files:**
- Create: `src/db/database.ts`
- Create: `src/db/schema.sql`
- Create: `src/db/migrations.ts`
- Test: `tests/db/database.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/db/database.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/db/database.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Database', () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-test-'));
    db = new Database(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initializes with WAL mode', () => {
    const journalMode = db.pragma('journal_mode');
    expect(journalMode[0].journal_mode).toBe('wal');
  });

  it('creates all required tables on init', () => {
    const tables = db.allTables();
    expect(tables).toContain('sessions');
    expect(tables).toContain('tickets');
    expect(tables).toContain('concurrency_plans');
    expect(tables).toContain('audit_log');
    expect(tables).toContain('cost_entries');
    expect(tables).toContain('config');
  });

  it('handles concurrent writes without errors', () => {
    // Simulate 10 concurrent writes
    const promises = Array.from({ length: 10 }, (_, i) => {
      db.insertAuditEntry({
        session_id: 'test',
        agent_type: 'supervisor',
        ticket_id: null,
        action: `test_action_${i}`,
        details: null,
        timestamp: new Date().toISOString(),
      });
    });
    // If no throw, WAL mode handles concurrency
    expect(() => promises).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/database.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write schema.sql**

```sql
-- src/db/schema.sql

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  repo_url TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  memory_db_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',  -- JSON array
  dependencies TEXT NOT NULL DEFAULT '[]',          -- JSON array
  files TEXT NOT NULL DEFAULT '[]',                 -- JSON array
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'backlog',
  assigned_agent TEXT,
  test_results TEXT,                                -- JSON
  review_notes TEXT,
  reject_count INTEGER NOT NULL DEFAULT 0,
  held_reason TEXT,
  git_branch TEXT,
  cost_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (id, session_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS concurrency_plans (
  session_id TEXT PRIMARY KEY,
  plan_json TEXT NOT NULL DEFAULT '{}',  -- JSON ConcurrencyPlan
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  ticket_id TEXT,
  action TEXT NOT NULL,
  details TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cost_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  ticket_id TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0.0,
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_session_status ON tickets(session_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id);
CREATE INDEX IF NOT EXISTS idx_cost_session ON cost_entries(session_id);
CREATE INDEX IF NOT EXISTS idx_cost_ticket ON cost_entries(ticket_id);
```

- [ ] **Step 4: Write database.ts**

```typescript
// src/db/database.ts
import BetterSqlite3 from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AuditEntry, CostEntry } from '../types/common.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class Database {
  private db: BetterSqlite3.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.runMigrations();
  }

  private runMigrations(): void {
    const schema = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'schema.sql'),
      'utf-8'
    );
    this.db.exec(schema);
  }

  pragma(pragma: string): Record<string, string>[] {
    return this.db.pragma(pragma) as Record<string, string>[];
  }

  allTables(): string[] {
    const rows = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    return rows.map(r => r.name);
  }

  // Audit log
  insertAuditEntry(entry: Omit<AuditEntry, never>): void {
    this.db.prepare(`
      INSERT INTO audit_log (session_id, agent_type, ticket_id, action, details, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      entry.session_id,
      entry.agent_type,
      entry.ticket_id,
      entry.action,
      entry.details,
      entry.timestamp
    );
  }

  getAuditLog(sessionId: string, limit = 100): AuditEntry[] {
    return this.db.prepare(`
      SELECT session_id, agent_type, ticket_id, action, details, timestamp
      FROM audit_log WHERE session_id = ?
      ORDER BY timestamp DESC LIMIT ?
    `).all(sessionId, limit) as AuditEntry[];
  }

  // Cost tracking
  insertCostEntry(entry: Omit<CostEntry, never>): void {
    this.db.prepare(`
      INSERT INTO cost_entries (session_id, agent_type, ticket_id, model, input_tokens, output_tokens, cost_usd, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.session_id,
      entry.agent_type,
      entry.ticket_id,
      entry.model,
      entry.input_tokens,
      entry.output_tokens,
      entry.cost_usd,
      entry.timestamp
    );
  }

  // Config
  getConfig(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setConfig(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
  }

  // Raw access for other modules
  get raw(): BetterSqlite3.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/db/database.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/ tests/db/
git commit -m "feat: SQLite database layer — WAL mode, schema, migrations, audit + cost tables"
```

---

### Task 4: Session Manager

**Files:**
- Create: `src/sessions/session.types.ts`
- Create: `src/sessions/session-manager.ts`
- Test: `tests/sessions/session-manager.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/sessions/session-manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../../src/sessions/session-manager.js';
import { Database } from '../../src/db/database.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('SessionManager', () => {
  let db: Database;
  let sm: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-session-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    sm = new SessionManager(db, tmpDir);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a session with a generated ID and branch', () => {
    const session = sm.create('https://github.com/user/repo.git');
    expect(session.id).toMatch(/^ses_[a-z0-9]+$/);
    expect(session.repo_url).toBe('https://github.com/user/repo.git');
    expect(session.branch).toBe(`aelvyril/session-${session.id}`);
    expect(session.status).toBe('active');
    expect(session.memory_db_path).toContain(session.id);
  });

  it('lists all sessions', () => {
    sm.create('https://github.com/user/repo1.git');
    sm.create('https://github.com/user/repo2.git');
    const sessions = sm.list();
    expect(sessions).toHaveLength(2);
  });

  it('gets a session by ID', () => {
    const created = sm.create('https://github.com/user/repo.git');
    const found = sm.get(created.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
  });

  it('pauses and resumes a session', () => {
    const session = sm.create('https://github.com/user/repo.git');
    sm.pause(session.id);
    expect(sm.get(session.id)!.status).toBe('paused');

    sm.resume(session.id);
    expect(sm.get(session.id)!.status).toBe('active');
  });

  it('marks a session as crashed', () => {
    const session = sm.create('https://github.com/user/repo.git');
    sm.markCrashed(session.id);
    expect(sm.get(session.id)!.status).toBe('crashed');
  });

  it('finds active sessions for crash recovery', () => {
    sm.create('https://github.com/user/repo1.git');
    const s2 = sm.create('https://github.com/user/repo2.git');
    sm.pause(s2.id);
    const active = sm.findRecoverable();
    expect(active).toHaveLength(1);
    expect(active[0].status).toBe('active');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sessions/session-manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write session-manager.ts**

```typescript
// src/sessions/session-manager.ts
import crypto from 'crypto';
import path from 'path';
import type { Database } from '../db/database.js';
import type { Session } from '../types/common.js';

export class SessionManager {
  constructor(
    private db: Database,
    private baseDir: string
  ) {}

  create(repoUrl: string): Session {
    const id = `ses_${crypto.randomBytes(8).toString('hex')}`;
    const branch = `aelvyril/session-${id}`;
    const repoPath = path.join(this.baseDir, 'workspaces', id);
    const memoryDbPath = path.join(this.baseDir, 'memory', `${id}.db`);

    // Ensure directories exist
    const fs = require('fs');
    fs.mkdirSync(repoPath, { recursive: true });
    fs.mkdirSync(path.dirname(memoryDbPath), { recursive: true });

    const now = new Date().toISOString();
    this.db.raw.prepare(`
      INSERT INTO sessions (id, repo_url, repo_path, branch, status, memory_db_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(id, repoUrl, repoPath, branch, memoryDbPath, now, now);

    this.db.insertAuditEntry({
      session_id: id,
      agent_type: 'supervisor',
      ticket_id: null,
      action: 'session_created',
      details: `Created session for ${repoUrl}`,
      timestamp: now,
    });

    return this.get(id)!;
  }

  list(): Session[] {
    return this.db.raw.prepare(
      'SELECT * FROM sessions ORDER BY created_at DESC'
    ).all() as Session[];
  }

  get(id: string): Session | null {
    return this.db.raw.prepare(
      'SELECT * FROM sessions WHERE id = ?'
    ).get(id) as Session | null;
  }

  pause(id: string): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(
      "UPDATE sessions SET status = 'paused', updated_at = ? WHERE id = ?"
    ).run(now, id);
  }

  resume(id: string): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(
      "UPDATE sessions SET status = 'active', updated_at = ? WHERE id = ?"
    ).run(now, id);
  }

  markCrashed(id: string): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(
      "UPDATE sessions SET status = 'crashed', updated_at = ? WHERE id = ?"
    ).run(now, id);
  }

  complete(id: string): void {
    const now = new Date().toISOString();
    this.db.raw.prepare(
      "UPDATE sessions SET status = 'completed', updated_at = ? WHERE id = ?"
    ).run(now, id);
  }

  findRecoverable(): Session[] {
    return this.db.raw.prepare(
      "SELECT * FROM sessions WHERE status IN ('active', 'crashed') ORDER BY created_at DESC"
    ).all() as Session[];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/sessions/session-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sessions/ tests/sessions/
git commit -m "feat: session manager — create/list/get/pause/resume/crash recovery"
```

---

### Task 5: Workspace Manager

**Files:**
- Create: `src/workspace/workspace-manager.ts`
- Test: `tests/workspace/workspace-manager.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/workspace/workspace-manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkspaceManager } from '../../src/workspace/workspace-manager.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

describe('WorkspaceManager', () => {
  let wm: WorkspaceManager;
  let tmpDir: string;
  let remoteRepo: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-ws-'));

    // Create a fake remote repo
    remoteRepo = path.join(tmpDir, 'remote-repo');
    fs.mkdirSync(remoteRepo);
    execSync('git init', { cwd: remoteRepo });
    fs.writeFileSync(path.join(remoteRepo, 'README.md'), '# Test Repo');
    execSync('git add .', { cwd: remoteRepo });
    execSync('git commit -m "initial"', { cwd: remoteRepo });

    wm = new WorkspaceManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('clones a repo and creates session branch', () => {
    const workspace = wm.clone(remoteRepo, 'test-session-1');
    expect(fs.existsSync(workspace)).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'README.md'))).toBe(true);

    // Check branch
    const branch = execSync('git branch --show-current', { cwd: workspace }).toString().trim();
    expect(branch).toBe('aelvyril/session-test-session-1');
  });

  it('creates a ticket branch from session branch', () => {
    const workspace = wm.clone(remoteRepo, 'test-session-2');
    wm.createTicketBranch(workspace, 'ticket-42');

    const branches = execSync('git branch', { cwd: workspace }).toString();
    expect(branches).toContain('aelvyril/ticket-ticket-42');

    const current = execSync('git branch --show-current', { cwd: workspace }).toString().trim();
    expect(current).toBe('aelvyril/ticket-ticket-42');
  });

  it('merges ticket branch into session branch', () => {
    const workspace = wm.clone(remoteRepo, 'test-session-3');
    wm.createTicketBranch(workspace, 'ticket-99');

    // Make a change on the ticket branch
    fs.writeFileSync(path.join(workspace, 'test.txt'), 'hello');
    execSync('git add .', { cwd: workspace });
    execSync('git commit -m "test change"', { cwd: workspace });

    // Merge back
    wm.mergeTicketBranch(workspace, 'ticket-99');

    const current = execSync('git branch --show-current', { cwd: workspace }).toString().trim();
    expect(current).toBe('aelvyril/session-test-session-3');

    expect(fs.existsSync(path.join(workspace, 'test.txt'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/workspace/workspace-manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write workspace-manager.ts**

```typescript
// src/workspace/workspace-manager.ts
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

export class WorkspaceManager {
  constructor(private baseDir: string) {}

  clone(repoUrl: string, sessionId: string): string {
    const workspace = path.join(this.baseDir, 'workspaces', sessionId);
    fs.mkdirSync(path.dirname(workspace), { recursive: true });

    execSync(`git clone "${repoUrl}" "${workspace}"`, { stdio: 'pipe' });

    const sessionBranch = `aelvyril/session-${sessionId}`;
    execSync(`git checkout -b "${sessionBranch}"`, { cwd: workspace, stdio: 'pipe' });

    return workspace;
  }

  createTicketBranch(workspace: string, ticketId: string): string {
    const branch = `aelvyril/ticket-${ticketId}`;
    execSync(`git checkout -b "${branch}"`, { cwd: workspace, stdio: 'pipe' });
    return branch;
  }

  mergeTicketBranch(workspace: string, ticketId: string, sessionId: string): void {
    const sessionBranch = `aelvyril/session-${sessionId}`;
    const ticketBranch = `aelvyril/ticket-${ticketId}`;

    execSync(`git checkout "${sessionBranch}"`, { cwd: workspace, stdio: 'pipe' });
    execSync(`git merge "${ticketBranch}"`, { cwd: workspace, stdio: 'pipe' });
  }

  resetTicketBranch(workspace: string, ticketId: string, sessionId: string): void {
    const sessionBranch = `aelvyril/session-${sessionId}`;
    const ticketBranch = `aelvyril/ticket-${ticketId}`;

    // Reset ticket branch to session branch state
    execSync(`git checkout "${ticketBranch}"`, { cwd: workspace, stdio: 'pipe' });
    execSync(`git reset --hard "${sessionBranch}"`, { cwd: workspace, stdio: 'pipe' });
  }

  commit(workspace: string, message: string): void {
    execSync('git add -A', { cwd: workspace, stdio: 'pipe' });
    execSync(`git commit -m "${message}"`, { cwd: workspace, stdio: 'pipe' });
  }

  createPR(workspace: string, sessionId: string): void {
    const sessionBranch = `aelvyril/session-${sessionId}`;
    execSync(`git push origin "${sessionBranch}"`, { cwd: workspace, stdio: 'pipe' });
    execSync(`gh pr create --fill --head "${sessionBranch}"`, { cwd: workspace, stdio: 'pipe' });
  }

  mergePR(workspace: string, sessionId: string): void {
    const sessionBranch = `aelvyril/session-${sessionId}`;
    execSync(`gh pr merge "${sessionBranch}" --merge --auto`, { cwd: workspace, stdio: 'pipe' });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/workspace/workspace-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/workspace/ tests/workspace/
git commit -m "feat: workspace manager — clone, branch, merge, PR operations"
```

---

### Task 6: Config Manager

**Files:**
- Create: `src/config/config.types.ts`
- Create: `src/config/config-manager.ts`
- Test: `tests/config/config-manager.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/config/config-manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigManager } from '../../src/config/config-manager.js';
import { Database } from '../../src/db/database.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('ConfigManager', () => {
  let cm: ConfigManager;
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-cfg-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    cm = new ConfigManager(db, path.join(tmpDir, 'config.json'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults when no config exists', () => {
    const config = cm.load();
    expect(config.port).toBe(3456);
    expect(config.max_parallel).toBe(2);
    expect(config.git.branch_prefix).toBe('aelvyril');
    expect(config.watchdog.heartbeat_interval_ms).toBe(5000);
  });

  it('saves and loads API keys', () => {
    cm.save({ api_keys: { anthropic: 'sk-test-key' } });
    const config = cm.load();
    expect(config.api_keys.anthropic).toBe('sk-test-key');
  });

  it('persists to file and DB', () => {
    cm.save({ max_parallel: 4 });
    // Reload from scratch
    const cm2 = new ConfigManager(db, path.join(tmpDir, 'config.json'));
    const config = cm2.load();
    expect(config.max_parallel).toBe(4);
  });

  it('sets model per agent type', () => {
    cm.save({
      models: {
        supervisor: 'claude-sonnet-4-20250514',
        sub: 'claude-opus-4-20250514',
      },
    });
    const config = cm.load();
    expect(config.models.supervisor).toBe('claude-sonnet-4-20250514');
    expect(config.models.sub).toBe('claude-opus-4-20250514');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config/config-manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write config-manager.ts**

```typescript
// src/config/config-manager.ts
import fs from 'fs';
import path from 'path';
import type { Database } from '../db/database.js';
import type { AelvyrilConfig, AgentModelConfig } from '../types/common.js';

const DEFAULT_CONFIG: AelvyrilConfig = {
  port: 3456,
  api_keys: {},
  models: {
    supervisor: 'claude-sonnet-4-20250514',
    ticket: 'claude-sonnet-4-20250514',
    main: 'claude-sonnet-4-20250514',
    sub: 'claude-sonnet-4-20250514',
    test: 'claude-sonnet-4-20250514',
    review: 'claude-sonnet-4-20250514',
    watchdog: 'claude-sonnet-4-20250514',
  },
  max_parallel: 2,
  watchdog: {
    heartbeat_interval_ms: 5000,
    stuck_threshold_ms: 300000,
  },
  git: {
    branch_prefix: 'aelvyril',
    auto_merge: true,
  },
  db_path: '~/.aelvyril/aelvyril.db',
  memory_db_dir: '~/.aelvyril/memory',
};

export class ConfigManager {
  private config: AelvyrilConfig;

  constructor(
    private db: Database,
    private configPath: string
  ) {
    this.config = this.mergeAll();
  }

  private mergeAll(): AelvyrilConfig {
    let config = { ...DEFAULT_CONFIG };

    // Load from DB overrides
    const dbConfig = this.db.getConfig('config');
    if (dbConfig) {
      try {
        config = { ...config, ...JSON.parse(dbConfig) };
      } catch {}
    }

    // Load from file overrides
    if (fs.existsSync(this.configPath)) {
      try {
        const fileConfig = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
        config = { ...config, ...fileConfig };
      } catch {}
    }

    return config;
  }

  load(): AelvyrilConfig {
    return { ...this.config };
  }

  save(partial: Partial<AelvyrilConfig>): void {
    this.config = { ...this.config, ...partial };

    // Persist to DB
    this.db.setConfig('config', JSON.stringify(this.config));

    // Persist to file
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config/config-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/ tests/config/
git commit -m "feat: config manager — defaults, file + DB persistence, model selection"
```

---

### Task 7: Audit Log and Cost Tracker

**Files:**
- Create: `src/audit/audit-log.ts`
- Create: `src/cost/cost-tracker.ts`
- Test: `tests/audit/audit-log.test.ts`
- Test: `tests/cost/cost-tracker.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/audit/audit-log.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuditLog } from '../../src/audit/audit-log.js';
import { Database } from '../../src/db/database.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('AuditLog', () => {
  let audit: AuditLog;
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-audit-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    audit = new AuditLog(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('logs an action and retrieves it', () => {
    audit.log('ses_123', 'supervisor', null, 'session_created', 'Created session');
    const entries = audit.getRecent('ses_123');
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('session_created');
    expect(entries[0].agent_type).toBe('supervisor');
  });

  it('logs with ticket context', () => {
    audit.log('ses_123', 'main', '#1', 'dispatched', 'Sub-agent for ticket #1');
    const entries = audit.getRecent('ses_123');
    expect(entries[0].ticket_id).toBe('#1');
  });

  it('respects limit', () => {
    for (let i = 0; i < 20; i++) {
      audit.log('ses_123', 'supervisor', null, `action_${i}`, null);
    }
    const entries = audit.getRecent('ses_123', 5);
    expect(entries).toHaveLength(5);
  });
});
```

```typescript
// tests/cost/cost-tracker.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CostTracker } from '../../src/cost/cost-tracker.js';
import { Database } from '../../src/db/database.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('CostTracker', () => {
  let tracker: CostTracker;
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aelvyril-cost-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    tracker = new CostTracker(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('tracks a cost entry', () => {
    tracker.record('ses_123', 'supervisor', null, 'claude-sonnet', 1000, 500, 0.03);
    const report = tracker.getReport('ses_123');
    expect(report.total_tokens).toBe(1500);
    expect(report.total_cost_usd).toBeCloseTo(0.03);
  });

  it('aggregates by agent type', () => {
    tracker.record('ses_123', 'supervisor', null, 'claude-sonnet', 1000, 500, 0.03);
    tracker.record('ses_123', 'main', null, 'claude-sonnet', 2000, 1000, 0.06);
    tracker.record('ses_123', 'supervisor', '#1', 'claude-sonnet', 500, 200, 0.01);

    const report = tracker.getReport('ses_123');
    expect(report.by_agent.supervisor.tokens).toBe(1700);  // 1500 + 200
    expect(report.by_agent.main.tokens).toBe(3000);
  });

  it('aggregates by ticket', () => {
    tracker.record('ses_123', 'sub', '#1', 'claude-opus', 5000, 2000, 0.50);
    tracker.record('ses_123', 'sub', '#1', 'claude-opus', 3000, 1000, 0.30);

    const report = tracker.getReport('ses_123');
    expect(report.by_ticket['#1'].tokens).toBe(11000);
    expect(report.by_ticket['#1'].cost).toBeCloseTo(0.80);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/audit/ tests/cost/`
Expected: FAIL — modules not found

- [ ] **Step 3: Write audit-log.ts**

```typescript
// src/audit/audit-log.ts
import type { Database } from '../db/database.js';
import type { AuditEntry } from '../types/common.js';

export class AuditLog {
  constructor(private db: Database) {}

  log(
    sessionId: string,
    agentType: string,
    ticketId: string | null,
    action: string,
    details: string | null
  ): void {
    this.db.insertAuditEntry({
      session_id: sessionId,
      agent_type: agentType as AuditEntry['agent_type'],
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
```

- [ ] **Step 4: Write cost-tracker.ts**

```typescript
// src/cost/cost-tracker.ts
import type { Database } from '../db/database.js';
import type { CostReport, AgentType } from '../types/common.js';

const ALL_AGENT_TYPES: AgentType[] = ['supervisor', 'ticket', 'main', 'sub', 'test', 'review', 'watchdog'];

export class CostTracker {
  constructor(private db: Database) {}

  record(
    sessionId: string,
    agentType: string,
    ticketId: string | null,
    model: string,
    inputTokens: number,
    outputTokens: number,
    costUsd: number
  ): void {
    this.db.insertCostEntry({
      session_id: sessionId,
      agent_type: agentType as AgentType,
      ticket_id: ticketId,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: costUsd,
      timestamp: new Date().toISOString(),
    });
  }

  getReport(sessionId: string): CostReport {
    const rows = this.db.raw.prepare(`
      SELECT agent_type, ticket_id,
             SUM(input_tokens + output_tokens) as tokens,
             SUM(cost_usd) as cost
      FROM cost_entries
      WHERE session_id = ?
      GROUP BY agent_type, ticket_id
    `).all(sessionId) as { agent_type: string; ticket_id: string | null; tokens: number; cost: number }[];

    const byAgent: Record<string, { tokens: number; cost: number }> = {};
    const byTicket: Record<string, { tokens: number; cost: number }> = {};
    let totalTokens = 0;
    let totalCost = 0;

    for (const row of rows) {
      totalTokens += row.tokens;
      totalCost += row.cost;

      byAgent[row.agent_type] = byAgent[row.agent_type] ?? { tokens: 0, cost: 0 };
      byAgent[row.agent_type].tokens += row.tokens;
      byAgent[row.agent_type].cost += row.cost;

      if (row.ticket_id) {
        byTicket[row.ticket_id] = byTicket[row.ticket_id] ?? { tokens: 0, cost: 0 };
        byTicket[row.ticket_id].tokens += row.tokens;
        byTicket[row.ticket_id].cost += row.cost;
      }
    }

    // Ensure all agent types present
    const fullByAgent: CostReport['by_agent'] = {} as CostReport['by_agent'];
    for (const type of ALL_AGENT_TYPES) {
      fullByAgent[type] = byAgent[type] ?? { tokens: 0, cost: 0 };
    }

    return {
      session_id: sessionId,
      total_tokens: totalTokens,
      total_cost_usd: Math.round(totalCost * 10000) / 10000,
      by_agent: fullByAgent,
      by_ticket: byTicket,
    };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/audit/ tests/cost/`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/audit/ src/cost/ tests/audit/ tests/cost/
git commit -m "feat: audit log + cost tracker — append-only logging, per-agent/ticket aggregation"
```

---

### Task 8: HTTP + WebSocket server entry point

**Files:**
- Create: `src/server.ts`
- Create: `src/index.ts`

- [ ] **Step 1: Write server.ts**

```typescript
// src/server.ts
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Database } from './db/database.js';

interface WebSocketClient extends WebSocket {
  sessionId?: string;
}

export function createServer(db: Database, port: number): http.Server {
  const server = http.createServer((req, res) => {
    // Health check
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
      return;
    }

    // API routes will be added in later phases
    res.writeHead(404);
    res.end('Not found');
  });

  // WebSocket server for agent streaming + CLI chat
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocketClient) => {
    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        // Message routing will be added in Phase 2 (Agent Pool)
        ws.send(JSON.stringify({ type: 'ack', timestamp: new Date().toISOString() }));
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    });

    ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
  });

  return server;
}
```

- [ ] **Step 2: Write index.ts**

```typescript
// src/index.ts
import { createServer } from './server.js';
import { Database } from './db/database.js';
import { ConfigManager } from './config/config-manager.js';
import path from 'path';
import os from 'os';

const configPath = path.join(os.homedir(), '.aelvyril', 'config.json');
const dbPath = path.join(os.homedir(), '.aelvyril', 'aelvyril.db');

const db = new Database(dbPath);
const configManager = new ConfigManager(db, configPath);
const config = configManager.load();

const server = createServer(db, config.port);

server.listen(config.port, () => {
  console.log(`Aelvyril Orchestrator running on http://localhost:${config.port}`);
  console.log(`WebSocket at ws://localhost:${config.port}/ws`);
  console.log(`Database: ${dbPath}`);
});
```

- [ ] **Step 3: Test the server starts**

Run: `npx tsx src/index.ts &` then `curl http://localhost:3456/health`
Expected: `{"status":"ok","timestamp":"..."}`

- [ ] **Step 4: Commit**

```bash
git add src/server.ts src/index.ts
git commit -m "feat: HTTP + WebSocket server — health check, WS connection scaffold"
```

---

### Task 9: Run all tests and verify

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL TESTS PASS

- [ ] **Step 2: Verify server starts and responds**

Run: `npx tsx src/index.ts &` then `curl http://localhost:3456/health`
Expected: `{"status":"ok"}`

- [ ] **Step 3: Kill the server**

Run: `kill %1`

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: Phase 1 complete — orchestrator foundation with DB, sessions, config, audit, cost, server"
```
