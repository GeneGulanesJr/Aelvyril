# Phase 0 — Monorepo Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `pi-subagent-driven-development` to implement this plan task-by-task. **Sequential mode** (one `worker` subagent per task, two-stage review). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pnpm monorepo with a typed `@aelvyril/shared` contracts package (event envelope, API schemas, namespace helper), lint/format tooling, and GitHub Actions CI — all green.

**Architecture:** pnpm workspaces; `packages/shared` holds zod schemas consumed later by `apps/web` and `apps/gateway`. No app packages yet — they arrive with their phases. TypeScript strict, ESLint flat config, vitest for tests.

**Tech Stack:** Node 22, pnpm 10 (corepack), TypeScript ^5.7, zod ^4, vitest ^3, ESLint ^9 flat config, Prettier (repo already has `.prettierrc`/`.prettierignore`).

**Repo state:** fresh repo at commit `a286775` containing `docs/` + `.gitignore` + prettier config. Working branch: `main`.

---

### Task 1: Workspace bootstrap

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `package.json` (root)

- [ ] **Step 1: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 2: Create root `package.json`**

```json
{
  "name": "aelvyril",
  "private": true,
  "packageManager": "pnpm@10.15.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "format": "prettier --write ."
  },
  "devDependencies": {
    "prettier": "^3.4.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 3: Install and verify workspace resolves**

Run: `corepack enable && pnpm install`
Expected: lockfile created (`pnpm-lock.yaml`), no errors.

- [ ] **Step 4: Commit**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml
git commit -m "chore: pnpm workspace bootstrap"
```

---

### Task 2: TypeScript base config

**Files:**
- Create: `tsconfig.base.json`

- [ ] **Step 1: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add tsconfig.base.json
git commit -m "chore: strict TypeScript base config"
```

---

### Task 3: `packages/shared` scaffold

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/vitest.config.ts`
- Create: `packages/shared/src/index.ts`
- Test: `packages/shared/src/scaffold.test.ts`

- [ ] **Step 1: Write the failing sanity test** — `packages/shared/src/scaffold.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "./index.js";

describe("scaffold", () => {
  it("exports a schema version", () => {
    expect(SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @aelvyril/shared test`
Expected: FAIL — cannot resolve `./index.js` / package missing.

- [ ] **Step 3: Create package files**

`packages/shared/package.json`:

```json
{
  "name": "@aelvyril/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "build": "tsc --noEmit"
  },
  "dependencies": { "zod": "^4.0.0" },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src"]
}
```

`packages/shared/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { environment: "node" } });
```

`packages/shared/src/index.ts`:

```ts
export const SCHEMA_VERSION = "0.1.0";
```

- [ ] **Step 4: Install and run test to verify it passes**

Run: `pnpm install && pnpm --filter @aelvyril/shared test`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/shared pnpm-lock.yaml
git commit -m "feat(shared): package scaffold with vitest"
```

---

### Task 4: Event envelope schema

**Files:**
- Create: `packages/shared/src/envelope.ts`
- Test: `packages/shared/src/envelope.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing tests** — `packages/shared/src/envelope.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { EventEnvelope, EnvelopeKind } from "./envelope.js";

const base = {
  seq: 1,
  conversationId: "conv_123",
  ts: "2026-09-22T12:00:00.000Z",
};

describe("EventEnvelope", () => {
  it("accepts a valid text_delta envelope", () => {
    const parsed = EventEnvelope.parse({
      ...base,
      kind: "text_delta",
      payload: { delta: "hello" },
    });
    expect(parsed.payload.delta).toBe("hello");
  });

  it("accepts a valid tool_call envelope", () => {
    const parsed = EventEnvelope.parse({
      ...base,
      kind: "tool_call",
      payload: { toolCallId: "c1", toolName: "bash", args: { cmd: "ls" } },
    });
    expect(parsed.payload.toolName).toBe("bash");
  });

  it("rejects an unknown kind", () => {
    expect(
      EventEnvelope.safeParse({ ...base, kind: "nope", payload: {} }).success,
    ).toBe(false);
  });

  it("rejects negative seq", () => {
    expect(
      EventEnvelope.safeParse({
        seq: -1,
        conversationId: "conv_123",
        ts: "2026-09-22T12:00:00.000Z",
        kind: "text_delta",
        payload: { delta: "x" },
      }).success,
    ).toBe(false);
  });

  it("covers every EnvelopeKind with a payload schema", () => {
    expect(EnvelopeKind.options).toEqual([
      "text_delta",
      "tool_call",
      "tool_result",
      "subagent_spawn",
      "sandbox_exec",
      "sandbox_promote",
      "laya_verdict",
      "session_state",
      "error",
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @aelvyril/shared test`
Expected: FAIL — `./envelope.js` not found.

- [ ] **Step 3: Implement** — `packages/shared/src/envelope.ts`

```ts
import { z } from "zod";

export const EnvelopeKind = z.enum([
  "text_delta",
  "tool_call",
  "tool_result",
  "subagent_spawn",
  "sandbox_exec",
  "sandbox_promote",
  "laya_verdict",
  "session_state",
  "error",
]);
export type EnvelopeKind = z.infer<typeof EnvelopeKind>;

const payloadSchemas = {
  text_delta: z.object({ delta: z.string() }),
  tool_call: z.object({
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    args: z.unknown(),
  }),
  tool_result: z.object({
    toolCallId: z.string().min(1),
    isError: z.boolean(),
  }),
  subagent_spawn: z.object({
    mode: z.enum(["single", "parallel", "chain"]),
    agents: z.array(z.object({ agent: z.string(), task: z.string() })).min(1),
  }),
  sandbox_exec: z.object({
    profile: z.string().min(1),
    sandboxId: z.string().min(1).optional(),
  }),
  sandbox_promote: z.object({
    sandboxId: z.string().min(1),
    paths: z.array(z.string()),
  }),
  laya_verdict: z.object({
    tool: z.string().min(1),
    verdict: z.record(z.string(), z.unknown()),
  }),
  session_state: z.object({
    state: z.enum(["idle", "streaming", "degraded", "restarted"]),
  }),
  error: z.object({
    message: z.string(),
    code: z.string().optional(),
  }),
} as const;

const envelopeShape = z.object({
  seq: z.number().int().nonnegative(),
  conversationId: z.string().min(1),
  ts: z.string().datetime({ offset: true }),
  kind: EnvelopeKind,
});

export const EventEnvelope = z.union(
  EnvelopeKind.options.map((kind) =>
    envelopeShape.extend({ kind: z.literal(kind), payload: payloadSchemas[kind] }),
  ),
);
export type EventEnvelope = z.infer<typeof EventEnvelope>;
```

- [ ] **Step 4: Re-export** — append to `packages/shared/src/index.ts`

```ts
export * from "./envelope.js";
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter @aelvyril/shared test`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): event envelope schema (spec §6)"
```

---

### Task 5: Namespace helper

**Files:**
- Create: `packages/shared/src/namespace.ts`
- Test: `packages/shared/src/namespace.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing tests** — `packages/shared/src/namespace.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { SHARED_NAMESPACE, toUserNamespace } from "./namespace.js";

describe("toUserNamespace", () => {
  it("prefixes a clerk user id", () => {
    expect(toUserNamespace("user_2AbC123")).toBe("user:user_2abc123");
  });

  it("lowercases (LaPis lowercases project keys)", () => {
    expect(toUserNamespace("USER_XYZ")).toBe("user:user_xyz");
  });

  it("rejects empty ids", () => {
    expect(() => toUserNamespace("")).toThrow();
  });
});

describe("SHARED_NAMESPACE", () => {
  it("is the platform scope", () => {
    expect(SHARED_NAMESPACE).toBe("platform");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @aelvyril/shared test`
Expected: FAIL — `./namespace.js` not found.

- [ ] **Step 3: Implement** — `packages/shared/src/namespace.ts`

```ts
/**
 * LaPis namespaces (spec §7): each Clerk user maps to a LaPis project-scope
 * namespace. Gateway injects this as LAPIS_PROJECT_KEY into session hosts.
 * LaPis lowercases project keys (src/hooks-engine/project.js:34) — we
 * pre-lowercase so gateway logs and memory keys always agree.
 */
export const SHARED_NAMESPACE = "platform";

export function toUserNamespace(clerkUserId: string): string {
  if (!clerkUserId.trim()) throw new Error("clerkUserId must be non-empty");
  return `user:${clerkUserId.toLowerCase()}`;
}
```

- [ ] **Step 4: Re-export** — append to `packages/shared/src/index.ts`

```ts
export * from "./namespace.js";
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter @aelvyril/shared test`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): user namespace mapping (spec §7, D7)"
```

---

### Task 6: API contracts

**Files:**
- Create: `packages/shared/src/api.ts`
- Test: `packages/shared/src/api.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing tests** — `packages/shared/src/api.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  CreateConversationBody,
  Conversation,
  PromptBody,
  ROUTES,
} from "./api.js";

describe("ROUTES", () => {
  it("defines the v1 surface", () => {
    expect(ROUTES.conversations).toBe("/v1/conversations");
    expect(ROUTES.conversationEvents(":id")).toBe(
      "/v1/conversations/:id/events",
    );
    expect(ROUTES.conversationPrompt(":id")).toBe(
      "/v1/conversations/:id/prompt",
    );
    expect(ROUTES.conversationAbort(":id")).toBe(
      "/v1/conversations/:id/abort",
    );
  });
});

describe("CreateConversationBody", () => {
  it("accepts minimal body", () => {
    expect(CreateConversationBody.parse({})).toEqual({});
  });
  it("accepts workspace", () => {
    expect(
      CreateConversationBody.parse({ title: "t", workspace: "LaPis" }),
    ).toEqual({ title: "t", workspace: "LaPis" });
  });
});

describe("PromptBody", () => {
  it("accepts a message", () => {
    expect(PromptBody.parse({ message: "hi" }).message).toBe("hi");
  });
  it("rejects empty message", () => {
    expect(PromptBody.safeParse({ message: "" }).success).toBe(false);
  });
  it("rejects messages over 1MB", () => {
    expect(PromptBody.safeParse({ message: "x".repeat(1_000_001) }).success).toBe(
      false,
    );
  });
});

describe("Conversation", () => {
  it("parses a DTO", () => {
    expect(
      Conversation.parse({
        id: "conv_1",
        title: null,
        workspace: null,
        state: "idle",
        createdAt: "2026-09-22T12:00:00.000Z",
      }).state,
    ).toBe("idle");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @aelvyril/shared test`
Expected: FAIL — `./api.js` not found.

- [ ] **Step 3: Implement** — `packages/shared/src/api.ts`

```ts
import { z } from "zod";

/** Route literals shared by apps/web (client) and apps/gateway (server). */
export const ROUTES = {
  conversations: "/v1/conversations",
  conversation: (id: string) => `/v1/conversations/${id}`,
  conversationEvents: (id: string) => `/v1/conversations/${id}/events`,
  conversationPrompt: (id: string) => `/v1/conversations/${id}/prompt`,
  conversationAbort: (id: string) => `/v1/conversations/${id}/abort`,
} as const;

export const CreateConversationBody = z.object({
  title: z.string().min(1).max(200).optional(),
  /** Workspace name from the host allowlist — never a raw path (spec §10). */
  workspace: z.string().min(1).optional(),
});
export type CreateConversationBody = z.infer<typeof CreateConversationBody>;

export const PromptBody = z.object({
  message: z.string().min(1).max(1_000_000),
  /** Required by gateway when the agent is already streaming (pi RPC semantics). */
  streamingBehavior: z.enum(["steer", "followUp"]).optional(),
});
export type PromptBody = z.infer<typeof PromptBody>;

export const ConversationState = z.enum([
  "idle",
  "streaming",
  "degraded",
]);
export type ConversationState = z.infer<typeof ConversationState>;

export const Conversation = z.object({
  id: z.string().min(1),
  title: z.string().nullable(),
  workspace: z.string().nullable(),
  state: ConversationState,
  createdAt: z.string().datetime({ offset: true }),
});
export type Conversation = z.infer<typeof Conversation>;
```

- [ ] **Step 4: Re-export** — append to `packages/shared/src/index.ts`

```ts
export * from "./api.js";
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter @aelvyril/shared test`
Expected: PASS (18 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): v1 API contracts (spec §6)"
```

---

### Task 7: ESLint (flat config)

**Files:**
- Create: `eslint.config.js` (root)
- Modify: `package.json` (root devDeps)

- [ ] **Step 1: Add devDeps to root `package.json`**

```json
"eslint": "^9.17.0",
"typescript-eslint": "^8.18.0"
```

- [ ] **Step 2: Create `eslint.config.js`**

```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/.next/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
```

- [ ] **Step 3: Install and run lint**

Run: `pnpm install && pnpm -r lint`
Expected: no errors (`shared` has lint script; root package has no lint script yet — acceptable, or add `"lint": "eslint ." scripts to shared only` as defined in Task 3).

- [ ] **Step 4: Fix any reported issues, then commit**

```bash
git add eslint.config.js package.json pnpm-lock.yaml
git commit -m "chore: eslint flat config (typescript-eslint)"
```

---

### Task 8: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r typecheck
      - run: pnpm -r lint
      - run: pnpm -r test
      - run: pnpm -r build
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: typecheck + lint + test + build on push/PR"
```

---

### Task 9: Full verification sweep

- [ ] **Step 1: Run everything from repo root**

Run: `pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm -r build`
Expected: all green, 18 shared tests passing.

- [ ] **Step 2: Push and confirm CI green**

Run: `git push origin main`
Expected: GitHub Actions `verify` job passes.

- [ ] **Step 3: Mark Phase 0 complete**

Update this plan's checkboxes; proceed to Phase 1 planning (gateway core) — which consumes the RPC protocol facts in spec §14.
