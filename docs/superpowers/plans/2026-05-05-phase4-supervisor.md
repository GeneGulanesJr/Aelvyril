# Phase 4: Supervisor Agent — User Chat Interface and Request Router

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Supervisor agent — the user's single point of contact. Handles chat via WebSocket, routes requests to the Ticket Agent, reports status, handles redirects, and manages session lifecycle.

**Architecture:** The Supervisor is a long-running pi process (the first agent spawned in a session). The web UI chat panel and `aelvyril chat` CLI both connect via WebSocket → Orchestrator → Supervisor. The Supervisor interprets user intent and dispatches to the appropriate agent.

**Tech Stack:** WebSocket, JSON-RPC, pi

**Spec reference:** `docs/superpowers/specs/2026-05-05-cloud-platform-design.md` §3.2, §3.3, §3.4

**Depends on:** Phase 1 (Foundation), Phase 2 (Agent Pool), Phase 3 (Kanban Board)

---

## File Structure

```
src/
├── supervisor/
│   ├── supervisor-agent.ts     # Supervisor logic — interpret user messages, route
│   ├── chat-handler.ts         # WebSocket chat message handler
│   └── supervisor.types.ts     # Supervisor message types
tests/
├── supervisor/
│   ├── supervisor-agent.test.ts
│   └── chat-handler.test.ts
```

---

### Task 1: Supervisor message types

**Files:**
- Create: `src/supervisor/supervisor.types.ts`

- [ ] **Step 1: Write the types**

```typescript
// src/supervisor/supervisor.types.ts

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
```

- [ ] **Step 2: Commit**

```bash
git add src/supervisor/supervisor.types.ts
git commit -m "feat: supervisor types — intent classification, chat messages, responses"
```

---

### Task 2: Intent classifier

**Files:**
- Create: `src/supervisor/supervisor-agent.ts`
- Test: `tests/supervisor/supervisor-agent.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/supervisor/supervisor-agent.test.ts
import { describe, it, expect } from 'vitest';
import { classifyIntent } from '../../src/supervisor/supervisor-agent.js';

describe('classifyIntent', () => {
  it('detects cancel intent', () => {
    expect(classifyIntent('stop everything')).toEqual({ type: 'cancel' });
    expect(classifyIntent('cancel')).toEqual({ type: 'cancel' });
  });

  it('detects status check intent', () => {
    expect(classifyIntent('status')).toEqual({ type: 'status_check' });
    expect(classifyIntent('what\'s the status')).toEqual({ type: 'status_check' });
    expect(classifyIntent('how\'s it going')).toEqual({ type: 'status_check' });
  });

  it('detects redirect intent with ticket ID', () => {
    const result = classifyIntent('actually for #3 do X instead');
    expect(result.type).toBe('redirect');
    if (result.type === 'redirect') {
      expect(result.ticket_id).toBe('#3');
      expect(result.content).toContain('X instead');
    }
  });

  it('defaults to new request for everything else', () => {
    expect(classifyIntent('Add dark mode to settings')).toEqual({
      type: 'new_request',
      content: 'Add dark mode to settings',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/supervisor/supervisor-agent.test.ts`
Expected: FAIL

- [ ] **Step 3: Write supervisor-agent.ts**

```typescript
// src/supervisor/supervisor-agent.ts
import type { SupervisorIntent } from './supervisor.types.js';

export function classifyIntent(message: string): SupervisorIntent {
  const lower = message.toLowerCase().trim();

  // Cancel
  if (/^(stop|cancel|abort|kill\s+all)/.test(lower)) {
    return { type: 'cancel' };
  }

  // Status check
  if (/^(status|what'?s?\s+(the\s+)?status|how'?s?\s+it\s+going|progress)/.test(lower)) {
    return { type: 'status_check' };
  }

  // Redirect — "for #N do X" or "change #N to X" or "#N actually do X"
  const redirectMatch = lower.match(/(?:for|change|redirect)\s+(#\d+)\s+(?:to|do|into)\s+(.+)/i)
    ?? lower.match(/(#\d+)\s+(?:actually|instead)\s+(.+)/i);
  if (redirectMatch) {
    return {
      type: 'redirect',
      ticket_id: redirectMatch[1],
      content: redirectMatch[2],
    };
  }

  // Default: new request
  return { type: 'new_request', content: message };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/supervisor/supervisor-agent.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/supervisor-agent.ts tests/supervisor/supervisor-agent.test.ts
git commit -m "feat: supervisor intent classifier — cancel, status, redirect, new request"
```

---

### Task 3: Chat handler (WebSocket message routing)

**Files:**
- Create: `src/supervisor/chat-handler.ts`
- Test: `tests/supervisor/chat-handler.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/supervisor/chat-handler.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/supervisor/chat-handler.test.ts`
Expected: FAIL

- [ ] **Step 3: Write chat-handler.ts**

```typescript
// src/supervisor/chat-handler.ts
import { classifyIntent } from './supervisor-agent.js';

export interface ChatHandlerCallbacks {
  onNewRequest: (content: string) => Promise<void> | void;
  onRedirect: (ticketId: string, content: string) => Promise<void> | void;
  onStatusCheck: () => Promise<unknown> | unknown;
  onCancel: () => Promise<void> | void;
  onConfigUpdate: (key: string, value: unknown) => Promise<void> | void;
}

export class ChatHandler {
  constructor(private callbacks: ChatHandlerCallbacks) {}

  async handleMessage(sessionId: string, content: string): Promise<unknown> {
    const intent = classifyIntent(content);

    switch (intent.type) {
      case 'new_request':
        return this.callbacks.onNewRequest(intent.content);
      case 'redirect':
        return this.callbacks.onRedirect(intent.ticket_id, intent.content);
      case 'status_check':
        return this.callbacks.onStatusCheck();
      case 'cancel':
        return this.callbacks.onCancel();
      case 'config_update':
        return this.callbacks.onConfigUpdate(intent.key, intent.value);
      case 'unknown':
        return this.callbacks.onNewRequest(content); // Fallback to new request
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/supervisor/chat-handler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/chat-handler.ts tests/supervisor/chat-handler.test.ts
git commit -m "feat: chat handler — route user messages to appropriate supervisor callbacks"
```

---

### Task 4: Run all Phase 4 tests

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL TESTS PASS

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "chore: Phase 4 complete — supervisor agent with intent classification and chat routing"
```
