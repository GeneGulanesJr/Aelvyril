# Phase 2 — Web Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `pi-subagent-driven-development` to implement this plan task-by-task. **Sequential mode** (one `worker` subagent per task, two-stage review). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Next.js + Clerk web app where a signed-in user creates conversations, sends prompts, and watches the agent stream live over SSE — with the gateway enforcing Clerk JWT auth and per-user LaPis namespaces.

**Architecture:** Two moves. (1) **Gateway grows auth**: bearer-token verification injected as a `TokenVerifier` (Clerk impl via `@clerk/backend`, fake impl in tests), every `/v1` route scoped to `toUserNamespace(userId)`, conversations gain a `namespace` column, CORS for the web origin, and per-conversation child env now carries `LAPIS_PROJECT_KEY`. (2) **Web app**: Next.js App Router + `@clerk/nextjs`; streaming uses **fetch + ReadableStream** (NOT `EventSource` — it cannot send an `Authorization` header), parsing the same SSE grammar the gateway emits.

**Tech Stack:** Next.js ^15 (App Router, React 19), `@clerk/nextjs` ^6 + `@clerk/backend` ^1, Tailwind ^4, `@fastify/cors` ^10. Gateway defaults stay intact; new env: `GATEWAY_ALLOWED_ORIGIN`, `CLERK_SECRET_KEY`.

**Blocking prerequisite (human):** real Clerk keys (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`) in `apps/web/.env` + `apps/gateway/.env`. Build/tests use documented placeholders (`pk_test_placeholder` / `sk_test_placeholder`) so CI stays green; the app is only fully functional with real keys.

> **STATUS (2026-09-23):** Tasks 1–4 DONE and committed — `9f3b333` (gateway auth), `1b7808c` (web scaffold), `bdc33c1` (SSE parser + client), `cf02285` (chat UI). Task 5 battery green (17 shared + 30 gateway + 4 web tests; web build ✓) and root README added. Remaining: `clerk auth login` → `clerk init --app app_3JiIWEGy3UjKJJQAmVA3pTSvd3r` (writes real keys), `clerk doctor`, two-process smoke with real sign-in.
>
> Implementation deviations from this plan (all reviewed): `buildApp` is async (fastify plugin ordering); `@clerk/backend` resolved v3 → standalone `verifyToken(token, { secretKey })` export; supervisor relays `custom_*` events to the bus (needed for the D7 env-echo assertion); namespace index created after the legacy `ALTER TABLE`; `@clerk/nextjs` v6 rejects ALL placeholder publishable keys at prerender → root layout uses `dynamic = "force-dynamic"`; webpack `extensionAlias` in `next.config.ts` for `.js`→`.ts` workspace resolution; web `test` script uses `--passWithNoTests` until Task 3 landed.

---

### Task 1: Gateway — auth, namespace scoping, CORS

**Files:**
- Create: `apps/gateway/src/auth.ts`
- Modify: `apps/gateway/src/store.ts` (namespace column)
- Modify: `apps/gateway/src/supervisor.ts` (env pass-through)
- Modify: `apps/gateway/src/app.ts` (routes + CORS + verifier wiring)
- Modify: `apps/gateway/package.json` (add `@clerk/backend`, `@fastify/cors`)
- Test: `apps/gateway/src/auth.test.ts`
- Test: `apps/gateway/src/routes.test.ts` (rewrite for auth)
- Test: `apps/gateway/src/sse.test.ts` (rewrite for auth)

- [ ] **Step 1: Add deps**

```bash
pnpm --filter @aelvyril/gateway add @clerk/backend @fastify/cors
```

- [ ] **Step 2: Write failing auth tests** — `apps/gateway/src/auth.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { TokenVerifier } from "./auth.js";

const fakePi = fileURLToPath(new URL("../fixtures/fake-pi.mjs", import.meta.url));
const okVerifier: TokenVerifier = async (token) =>
  token === "good" ? { userId: "user_TEST1" } : null;

// helper: authenticated request helpers used across this file
function authed(app: App, token: string) {
  return {
    get: (url: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } }),
    post: (url: string, payload?: unknown) =>
      app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload }),
  };
}

describe("auth", () => {
  it("401s /v1 routes without a token", async () => {
    const app = buildApp({
      dbPath: ":memory:",
      childCommand: process.execPath,
      childArgs: [fakePi],
      verifyToken: okVerifier,
    });
    const res = await app.inject({ method: "GET", url: "/v1/conversations" });
    expect(res.statusCode).toBe(401);
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    await app.close();
  });

  it("401s on a bad token", async () => {
    const app = buildApp({
      dbPath: ":memory:", childCommand: process.execPath, childArgs: [fakePi], verifyToken: okVerifier,
    });
    const res = await authed(app, "nope").get("/v1/conversations");
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("scopes conversations per namespace (spec §2)", async () => {
    const app = buildApp({
      dbPath: ":memory:", childCommand: process.execPath, childArgs: [fakePi], verifyToken: okVerifier,
    });
    const u1 = authed(app, "good"); // user_test1
    const u2 = authed(app, "good2"); // via verifier2 below — instead: second app
    await u1.post("/v1/conversations", { title: "mine" });
    const list = await u1.get("/v1/conversations");
    expect(list.json().conversations).toHaveLength(1);
    await app.close();
  });

  it("rejects cross-user access to another user's conversation", async () => {
    const verifiers = {
      a: (async (token: string) => (token === "ta" ? { userId: "user_A" } : null)) as TokenVerifier,
    };
    const appA = buildApp({
      dbPath: ":memory:", childCommand: process.execPath, childArgs: [fakePi], verifyToken: verifiers.a,
    });
    const convA = await (await authed(appA, "ta").post("/v1/conversations", {})).json();
    await appA.close();

    const appB = buildApp({
      dbPath: ":memory:", childCommand: process.execPath, childArgs: [fakePi],
      verifyToken: (async (token: string) =>
        token === "tb" ? { userId: "user_B" } : null) as TokenVerifier,
      sharedDbPath: undefined,
    });
    // same in-memory db is not shareable across apps; cross-tenant check uses one app, two users:
    const app = buildApp({
      dbPath: ":memory:", childCommand: process.execPath, childArgs: [fakePi],
      verifyToken: async (token: string) =>
        token === "ta" ? { userId: "user_A" } : token === "tb" ? { userId: "user_B" } : null,
    });
    const conv = await (await authed(app, "ta").post("/v1/conversations", {})).json();
    const stolen = await authed(app, "tb").get(`/v1/conversations/${conv.id}`);
    expect(stolen.statusCode).toBe(404);
    const mine = await authed(app, "ta").get(`/v1/conversations/${conv.id}`);
    expect(mine.statusCode).toBe(200);
    await app.close();
    void appA; void convA; void appB; void verifiers;
  });
});
```

NOTE: the `appA`/`appB` scaffolding in the fourth test is illustrative cruft — the worker SHOULD trim it to a single app with the two-token verifier (the essential assertion is `tb` gets 404 on `ta`'s conversation). Keep the test honest and minimal.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @aelvyril/gateway test`
Expected: FAIL — `./auth.js` not found / routes don't 401.

- [ ] **Step 4: Implement auth.ts**

```ts
import { createClerkClient } from "@clerk/backend";

export interface VerifiedUser {
  userId: string;
}

export type TokenVerifier = (token: string) => Promise<VerifiedUser | null>;

/**
 * Real Clerk verifier (spec §8). Bearer token on every /v1 call.
 * Requires CLERK_SECRET_KEY in the gateway env.
 */
export function createClerkVerifier(secretKey: string): TokenVerifier {
  const clerk = createClerkClient({ secretKey });
  return async (token) => {
    try {
      const claims = await clerk.verifyToken(token);
      if (!claims.sub) return null;
      return { userId: claims.sub };
    } catch {
      return null;
    }
  };
}
```

- [ ] **Step 5: Store gains namespace** — modify `apps/gateway/src/store.ts`:

- `CREATE TABLE conversations` gains `namespace TEXT NOT NULL DEFAULT 'platform'` plus `CREATE INDEX IF NOT EXISTS idx_conversations_namespace ON conversations(namespace);`
- After `exec`, run a lightweight migration for pre-existing DBs:
```ts
const cols = this.db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
if (!cols.some((c) => c.name === "namespace")) {
  this.db.exec("ALTER TABLE conversations ADD COLUMN namespace TEXT NOT NULL DEFAULT 'platform'");
}
```
- `createConversation(input: { title?; workspace?; namespace: string })` — inserts namespace, returns `Conversation & { namespace }` internally; the public DTO stays as-is (namespace is internal routing, not exposed — spec D-decision: server-side only).
- `getConversation(id, namespace)` and `listConversations(namespace)` — add `WHERE namespace = ?`.
- Update `store.test.ts` accordingly (createConversation now requires namespace; add a scoping test mirroring routes test).

- [ ] **Step 6: Supervisor env pass-through** — modify `apps/gateway/src/supervisor.ts`:

- `SupervisorOptions.spawnChild: (conversationId: string, extraEnv: Record<string, string>) => ChildProcess`
- `ensureSession(conversationId, extraEnv)` passes through; child spawn env merge happens in the app's `spawnChild` (gateway stays dependency-free of env policy):
```ts
spawnChild: (conversationId, extraEnv) =>
  spawn(opts.childCommand, opts.childArgs, {
    env: { ...process.env, ...extraEnv },
  }),
```
- `prompt(conversationId, message, streamingBehavior?, extraEnv?)` — forwards to `ensureSession`.
- Existing tests updated: `spawnChild: (conversationId, extraEnv) => { void conversationId; void extraEnv; return spawn(...); }`.

- [ ] **Step 7: Compose app.ts with auth + CORS**

Key deltas to the existing `app.ts`:
- `AppOptions` gains: `verifyToken: TokenVerifier; allowedOrigins?: string[];`
- Register CORS before routes:
```ts
await app.register(import("@fastify/cors"), {
  origin: opts.allowedOrigins ?? false,
  credentials: true,
});
```
- Helper inside `buildApp`:
```ts
const unauthorized = (reply: FastifyReply) => reply.code(401).send({ error: "unauthorized" });
async function user(req: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return void unauthorized(reply);
  const user = await opts.verifyToken(header.slice(7));
  if (!user) return void unauthorized(reply);
  return user.userId;
}
```
- Every `/v1` route starts with `const userId = await user(req, reply); if (!userId) return;` then uses `const namespace = toUserNamespace(userId);` (import from `@aelvyril/shared`) for store calls and `prompt(..., { LAPIS_PROJECT_KEY: namespace })`.
- `/healthz` stays open.

- [ ] **Step 8: Rewrite route/SSE tests for auth**

- `routes.test.ts` / `sse.test.ts` use `buildApp({..., verifyToken: testVerifier})` with a two-token verifier and an `authed()` helper (as in auth.test.ts). All fetch-based SSE tests send the `Authorization` header. The SSE first-test also asserts an **env echo**: extend `fixtures/fake-pi.mjs` — on `prompt`, before `turn_start`, emit one extra event `{"type":"custom_env_echo","LAPIS_PROJECT_KEY":process.env.LAPIS_PROJECT_KEY ?? null}` and have the SSE test assert the first `tool_call`-preceding custom event carries `user:user_test1`. (This proves the namespace reaches the session host — the D7 contract end-to-end.)

- [ ] **Step 9: Run full gateway suite**

Run: `pnpm --filter @aelvyril/gateway test && pnpm --filter @aelvyril/gateway typecheck && pnpm --filter @aelvyril/gateway lint`
Expected: all green (≥26 gateway tests).

- [ ] **Step 10: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): Clerk bearer auth + per-user namespace scoping + CORS (spec §2, §8)"
```

---

### Task 2: Web scaffold (Next.js + Clerk)

**Files:**
- Create: `apps/web/package.json`, `apps/web/next.config.ts`, `apps/web/tsconfig.json`, `apps/web/postcss.config.mjs`
- Create: `apps/web/app/layout.tsx`, `apps/web/app/globals.css`
- Create: `apps/web/app/sign-in/[[...rest]]/page.tsx`, `apps/web/app/sign-up/[[...rest]]/page.tsx`
- Create: `apps/web/middleware.ts`
- Create: `apps/web/.env.example`
- Modify: root `.gitignore` is already fine (`data/`, `.env*` covered)

- [ ] **Step 1: `apps/web/package.json`**

```json
{
  "name": "@aelvyril/web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3000",
    "build": "next build",
    "start": "next start -p 3000",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint ."
  },
  "dependencies": {
    "@aelvyril/shared": "workspace:*",
    "@clerk/nextjs": "^6.9.0",
    "next": "^15.3.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4.0.0",
    "@types/node": "^22.10.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "tailwindcss": "^4.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: configs**

`apps/web/next.config.ts`:
```ts
import type { NextConfig } from "next";

export default {
  transpilePackages: ["@aelvyril/shared"],
} satisfies NextConfig;
```

`apps/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "jsx": "preserve",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "allowJs": true,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "types": ["node"]
  },
  "include": ["**/*.ts", "**/*.tsx", "next-env.d.ts"],
  "exclude": ["node_modules", ".next"]
}
```

`apps/web/postcss.config.mjs`:
```js
export default { plugins: { "@tailwindcss/postcss": {} } };
```

`apps/web/app/globals.css`:
```css
@import "tailwindcss";
```

`apps/web/.env.example`:
```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_placeholder
CLERK_SECRET_KEY=sk_test_placeholder
NEXT_PUBLIC_GATEWAY_URL=http://localhost:8787
```

- [ ] **Step 3: layout + Clerk**

`apps/web/app/layout.tsx`:
```tsx
import { ClerkProvider } from "@clerk/nextjs";
import { esUS } from "@clerk/localizations";
import "./globals.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en" className="dark">
        <body className="min-h-screen bg-[#0d1117] text-[#e6edf3] antialiased">{children}</body>
      </html>
    </ClerkProvider>
  );
}
```
(If `@clerk/localizations` is not installed, drop the prop — localization is optional.)

`apps/web/app/sign-in/[[...rest]]/page.tsx`:
```tsx
import { SignIn } from "@clerk/nextjs";

export default function Page() {
  return <SignIn />;
}
```

`apps/web/app/sign-up/[[...rest]]/page.tsx`:
```tsx
import { SignUp } from "@clerk/nextjs";

export default function Page() {
  return <SignUp />;
}
```

`apps/web/middleware.ts`:
```ts
import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware();

export const config = { matcher: ["/((?!_next|.*\\..*).*)", "/"] };
```

- [ ] **Step 4: Placeholder env + build**

```bash
cp apps/web/.env.example apps/web/.env
pnpm install
pnpm --filter @aelvyril/web build
```
Expected: build succeeds (Next may warn about placeholder Clerk keys — acceptable). If `next build` demands a valid publishable key format, set `pk_test_00000000000000000000000000` in `.env` (test-mode shape) and note it.

- [ ] **Step 5: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): Next.js + Clerk scaffold"
```

---

### Task 3: Web lib — typed gateway client + SSE parser (TDD)

**Files:**
- Create: `apps/web/lib/sse.ts`
- Create: `apps/web/lib/api.ts`
- Test: `apps/web/lib/sse.test.ts`
- Create: `apps/web/vitest.config.ts`

- [ ] **Step 1: Failing parser tests** — `apps/web/lib/sse.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { SseParser } from "./sse.js";
import type { EventEnvelope } from "@aelvyril/shared";

function feed(parser: SseParser, text: string): EventEnvelope[] {
  const out: EventEnvelope[] = [];
  for (const e of parser.push(text)) out.push(e);
  return out;
}

describe("SseParser", () => {
  it("parses id/event/data blocks", () => {
    const p = new SseParser();
    const events = feed(
      p,
      'id: 0\nevent: session_state\ndata: {"seq":0,"conversationId":"c","ts":"2026-09-22T12:00:00.000Z","kind":"session_state","payload":{"state":"streaming"}}\n\n',
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("session_state");
  });

  it("skips retry/comment blocks without data", () => {
    const p = new SseParser();
    expect(feed(p, "retry: 2000\n\n")).toEqual([]);
    expect(feed(p, ": ping\n\n")).toEqual([]);
  });

  it("handles blocks split across pushes", () => {
    const p = new SseParser();
    expect(feed(p, 'id: 1\nevent: text_delta\ndata: {"seq":1')).toEqual([]);
    const events = feed(
      p,
      ',"conversationId":"c","ts":"2026-09-22T12:00:00.000Z","kind":"text_delta","payload":{"delta":"hi"}}\n\n',
    );
    expect(events[0]!.kind).toBe("text_delta");
  });

  it("ignores envelopes whose seq is not greater than lastSeq (dup guard)", () => {
    const p = new SseParser();
    const mk = (seq: number) =>
      `id: ${seq}\nevent: text_delta\ndata: {"seq":${seq},"conversationId":"c","ts":"2026-09-22T12:00:00.000Z","kind":"text_delta","payload":{"delta":"x"}}\n\n`;
    feed(p, mk(1));
    expect(feed(p, mk(1))).toEqual([]); // dup
    expect(feed(p, mk(2))).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @aelvyril/web test`
Expected: FAIL — vitest not configured for lib tests or ./sse.js missing.

- [ ] **Step 3: Implement**

`apps/web/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { environment: "node", include: ["lib/**/*.test.ts"] } });
```
(Add `"test": "vitest run"` exists already from scaffold.)

`apps/web/lib/sse.ts`:
```ts
import type { EventEnvelope } from "@aelvyril/shared";

/**
 * Incremental parser for the gateway's SSE grammar (Task 5, Phase 1):
 * blocks of `id:/event:/data:` separated by blank lines, `retry:` and
 * `: ping` comment lines interleaved. Enforces seq monotonicity so a
 * reconnect replay can never double-apply.
 */
export class SseParser {
  private buffer = "";
  private lastSeq = -1;

  push(chunk: string): EventEnvelope[] {
    this.buffer += chunk;
    const out: EventEnvelope[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue; // retry:/comment blocks
      const env = JSON.parse(dataLine.slice(6)) as EventEnvelope;
      if (typeof env.seq !== "number" || env.seq <= this.lastSeq) continue;
      this.lastSeq = env.seq;
      out.push(env);
    }
    return out;
  }

  get lastSeenSeq(): number {
    return this.lastSeq;
  }
}
```

- [ ] **Step 4: `apps/web/lib/api.ts`** (typed client; no test — exercised via E2E later)

```ts
import type { Conversation, CreateConversationBody, PromptBody } from "@aelvyril/shared";
import { ROUTES } from "@aelvyril/shared";
import { SseParser } from "./sse.js";
import type { EventEnvelope } from "@aelvyril/shared";

type GetToken = () => Promise<string | null>;

export class GatewayClient {
  constructor(
    private baseUrl: string,
    private getToken: GetToken,
  ) {}

  private async authed(init: RequestInit = {}): Promise<RequestInit> {
    const token = await this.getToken();
    if (!token) throw new Error("not signed in");
    return {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    };
  }

  async listConversations(): Promise<Conversation[]> {
    const res = await fetch(`${this.baseUrl}${ROUTES.conversations}`, await this.authed());
    if (!res.ok) throw new Error(`list failed: ${res.status}`);
    return ((await res.json()) as { conversations: Conversation[] }).conversations;
  }

  async createConversation(body: CreateConversationBody = {}): Promise<Conversation> {
    const res = await fetch(
      `${this.baseUrl}${ROUTES.conversations}`,
      await this.authed({ method: "POST", body: JSON.stringify(body) }),
    );
    if (!res.ok) throw new Error(`create failed: ${res.status}`);
    return (await res.json()) as Conversation;
  }

  async prompt(id: string, body: PromptBody): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}${ROUTES.conversationPrompt(id)}`,
      await this.authed({ method: "POST", body: JSON.stringify(body) }),
    );
    if (!res.ok) throw new Error(`prompt failed: ${res.status}`);
  }

  async abort(id: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}${ROUTES.conversationAbort(id)}`,
      await this.authed({ method: "POST" }),
    );
    if (!res.ok) throw new Error(`abort failed: ${res.status}`);
  }

  /**
   * Streaming fetch of the event channel (NOT EventSource — it cannot send
   * an Authorization header). Reconnects with Last-Event-ID until aborted.
   */
  openStream(
    id: string,
    onEnvelope: (env: EventEnvelope) => void,
    signal?: AbortSignal,
  ): () => void {
    const controller = new AbortController();
    if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
    void (async () => {
      const parser = new SseParser();
      while (!controller.signal.aborted) {
        try {
          const res = await fetch(`${this.baseUrl}${ROUTES.conversationEvents(id)}`, {
            headers: { authorization: `Bearer ${await this.getToken()}`, "last-event-id": String(parser.lastSeenSeq) },
            signal: controller.signal,
          });
          if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const env of parser.push(decoder.decode(value, { stream: true }))) {
              onEnvelope(env);
            }
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          console.error("stream error, retrying", err);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    })();
    return () => controller.abort();
  }
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter @aelvyril/web test`
Expected: PASS (4 parser tests).

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): SSE parser + typed gateway client"
```

---

### Task 4: Chat UI

**Files:**
- Create: `apps/web/app/page.tsx`
- Create: `apps/web/components/chat.tsx`
- Modify: `apps/web/app/layout.tsx` (metadata only, optional)

- [ ] **Step 1: `apps/web/components/chat.tsx`** — the conversation surface:

```tsx
"use client";

import { useAuth, useUser } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Conversation, EventEnvelope } from "@aelvyril/shared";
import { GatewayClient } from "../lib/api";

interface UiMessage {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
}

export function Chat() {
  const { getToken, userId } = useAuth();
  const { user } = useUser();
  const [client, setClient] = useState<GatewayClient | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"idle" | "streaming" | "degraded">("idle");
  const [error, setError] = useState<string | null>(null);
  const closeStream = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!getToken) return;
    setClient(new GatewayClient(process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787", getToken));
  }, [getToken]);

  const applyEnvelope = useCallback((env: EventEnvelope) => {
    setMessages((prev) => {
      switch (env.kind) {
        case "text_delta":
          return appendAssistant(prev, env.payload.delta);
        case "tool_call":
          return [...prev, { role: "tool", text: `⚙ ${env.payload.toolName}` }];
        case "tool_result":
          return prev;
        case "session_state":
          setStatus(env.payload.state === "streaming" ? "streaming" : env.payload.state === "degraded" ? "degraded" : "idle");
          return env.payload.state === "restarted"
            ? [...prev, { role: "system", text: "agent restarted — context restored" }]
            : prev;
        case "error":
          setError(env.payload.message);
          return prev;
        default:
          return prev;
      }
    });
  }, []);

  const openConversation = useCallback(
    (id: string) => {
      closeStream.current?.();
      setActiveId(id);
      setMessages([]);
      setError(null);
      if (!client) return;
      closeStream.current = client.openStream(id, applyEnvelope);
    },
    [client, applyEnvelope],
  );

  const refreshList = useCallback(async () => {
    if (!client) return;
    setConversations(await client.listConversations());
  }, [client]);

  useEffect(() => {
    void refreshList();
    return () => closeStream.current?.();
  }, [refreshList]);

  const send = useCallback(async () => {
    if (!client || !input.trim()) return;
    let id = activeId;
    if (!id) {
      const conv = await client.createConversation({});
      id = conv.id;
      setActiveId(id);
      openConversation(id);
    }
    setMessages((prev) => [...prev, { role: "user", text: input }]);
    setInput("");
    try {
      await client.prompt(id, { message: input });
    } catch (err) {
      setError(String(err));
    }
  }, [client, input, activeId, openConversation]);

  const statusLabel = useMemo(
    () => ({ idle: "idle", streaming: "working…", degraded: "degraded — will recover on next message" })[status],
    [status],
  );

  return (
    <main className="mx-auto flex h-screen max-w-3xl flex-col p-4">
      <header className="flex items-center justify-between pb-3">
        <h1 className="text-sm tracking-widest text-[#8b96a8]">AELVYRIL</h1>
        <div className="flex items-center gap-3 text-xs text-[#8b96a8]">
          <select
            className="rounded border border-[#2b3245] bg-[#161b27] px-2 py-1"
            value={activeId ?? ""}
            onChange={(e) => e.target.value && openConversation(e.target.value)}
          >
            <option value="">new conversation</option>
            {conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title ?? c.id.slice(0, 12)}
              </option>
            ))}
          </select>
          <span data-testid="status">{statusLabel}</span>
          <span>hi, {user?.firstName ?? userId}</span>
        </div>
      </header>

      {error && (
        <div className="mb-2 rounded border border-[#f0883e]/40 bg-[#f0883e]/10 px-3 py-2 text-xs text-[#f0883e]">
          {error}
          <button className="ml-2 underline" onClick={() => setError(null)}>dismiss</button>
        </div>
      )}

      <div className="flex-1 space-y-2 overflow-y-auto rounded-lg border border-[#2b3245] bg-[#161b27] p-4">
        {messages.map((m, i) => (
          <div
            key={i}
            className={
              m.role === "user"
                ? "ml-auto max-w-[80%] rounded-lg bg-[#1f6feb]/20 px-3 py-2 text-sm"
                : m.role === "tool"
                  ? "text-xs text-[#8b96a8]"
                  : m.role === "system"
                    ? "text-center text-xs text-[#e3b341]"
                    : "max-w-[80%] whitespace-pre-wrap rounded-lg bg-[#21262d] px-3 py-2 text-sm"
            }
          >
            {m.text}
          </div>
        ))}
        {messages.length === 0 && (
          <div className="grid h-full place-items-center text-sm text-[#8b96a8]">
            say something — pi is listening
          </div>
        )}
      </div>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          className="flex-1 rounded-lg border border-[#2b3245] bg-[#161b27] px-3 py-2 text-sm outline-none focus:border-[#1f6feb]"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="message the agent…"
        />
        <button
          className="rounded-lg bg-[#1f6feb] px-4 py-2 text-sm font-medium disabled:opacity-40"
          disabled={!input.trim()}
          type="submit"
        >
          send
        </button>
      </form>
    </main>
  );
}

function appendAssistant(prev: UiMessage[], delta: string): UiMessage[] {
  const last = prev[prev.length - 1];
  if (last && last.role === "assistant") {
    return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
  }
  return [...prev, { role: "assistant", text: delta }];
}
```

- [ ] **Step 2: `apps/web/app/page.tsx`**

```tsx
import { SignedIn, SignedOut, SignInButton } from "@clerk/nextjs";
import { Chat } from "../components/chat";

export default function Home() {
  return (
    <>
      <SignedOut>
        <main className="grid min-h-screen place-items-center">
          <div className="text-center">
            <h1 className="mb-4 text-2xl tracking-widest">AELVYRIL</h1>
            <SignInButton mode="modal">
              <button className="rounded-lg bg-[#1f6feb] px-4 py-2 text-sm">sign in</button>
            </SignInButton>
          </div>
        </main>
      </SignedOut>
      <SignedIn>
        <Chat />
      </SignedIn>
    </>
  );
}
```

- [ ] **Step 3: Typecheck + build**

```bash
pnpm --filter @aelvyril/web typecheck && pnpm --filter @aelvyril/web build
```
Expected: exit 0 (placeholder keys).

- [ ] **Step 4: Commit**

```bash
git add apps/web
git commit -m "feat(web): chat UI — conversations, live SSE stream, composer"
```

---

### Task 5: Full verification + dev docs

- [ ] **Step 1: Everything from root**

```bash
pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm --filter @aelvyril/web build
```
Expected: all green (17 shared + ≥26 gateway + 4 web tests; web build ok).

- [ ] **Step 2: Two-process smoke (fake child, placeholder keys)**

```bash
# terminal 1
GATEWAY_PORT=8787 PI_FAKE=1 CLERK_SECRET_KEY=sk_test_placeholder GATEWAY_ALLOWED_ORIGIN=http://localhost:3000 pnpm --filter @aelvyril/gateway start
# terminal 2
pnpm --filter @aelvyril/web dev
```
Manual: sign in via Clerk (needs REAL keys — with placeholders, document that the browser flow requires real dev keys; the build + gateway contract tests already prove the contract).

- [ ] **Step 3: Update root `README.md`** (create it — repo has none):

```md
# Aelvyril

Chat-first frontend for the GulanesKorp agent platform (pi + PiSubagent + LaPis + PiSandboxed + LayaMCP, all in Docker).
Spec: `docs/superpowers/specs/2026-09-22-aelvyril-agent-platform-design.md` · ADRs: `docs/adr/`

## Dev (no pi required)

    # terminal 1 — gateway with scripted fake child
    GATEWAY_PORT=8787 PI_FAKE=1 CLERK_SECRET_KEY=sk_test_placeholder GATEWAY_ALLOWED_ORIGIN=http://localhost:3000 pnpm --filter @aelvyril/gateway start
    # terminal 2 — web (needs real Clerk dev keys in apps/web/.env)
    pnpm --filter @aelvyril/web dev

Open http://localhost:3000.

## Checks

    pnpm -r typecheck && pnpm -r lint && pnpm -r test
```

- [ ] **Step 4: Commit + push**

```bash
git add README.md
git commit -m "docs: root readme — dev quickstart"
git push origin main
```
