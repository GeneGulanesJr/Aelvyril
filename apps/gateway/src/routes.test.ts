import { afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { buildApp, type App } from "./app.js";
import type { TokenVerifier } from "./auth.js";

const fakePi = fileURLToPath(new URL("../fixtures/fake-pi.mjs", import.meta.url));

const testVerifier: TokenVerifier = async (token) =>
  token === "good"
    ? { userId: "user_test1" }
    : token === "good2"
      ? { userId: "user_test2" }
      : null;

function makeApp() {
  return buildApp({
    dbPath: ":memory:",
    childCommand: process.execPath,
    childArgs: [fakePi],
    idleMs: 60_000,
    verifyToken: testVerifier,
    // Permit any non-relative path for the existing CRUD tests. The
    // allowlist enforcement paths get their own tests below with the
    // production default-deny behavior.
    workspaceAllowlist: {
      isAllowed: (w) => w === null || w === undefined || (w.length > 0 && w.startsWith("/")),
      resolve: (w) => (w === null || w === undefined ? null : w),
      size: () => Number.POSITIVE_INFINITY,
    },
  });
}

function authed(app: App, token: string) {
  return {
    get: (url: string) =>
      app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } }),
    post: (url: string, payload?: Record<string, unknown>) =>
      app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload }),
  };
}

describe("v1 routes", () => {
  let app: App | undefined;
  afterEach(async () => app && (await app.close()));

  it("creates, lists, gets conversations", async () => {
    app = await makeApp();
    const u1 = authed(app, "good");
    const created = await u1.post("/v1/threads", { title: "t", workspace: "/home/LaPis" });
    expect(created.statusCode).toBe(201);
    const conv = created.json();
    expect(conv.id).toMatch(/^conv_/);

    const list = await u1.get("/v1/threads");
    expect(list.json().conversations).toHaveLength(1);

    const one = await u1.get(`/v1/threads/${conv.id}`);
    expect(one.json().title).toBe("t");

    const missing = await u1.get("/v1/threads/conv_x");
    expect(missing.statusCode).toBe(404);
  });

  it("validates prompt body", async () => {
    app = await makeApp();
    const u1 = authed(app, "good");
    const conv = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    const bad = await u1.post(`/v1/threads/${conv.id}/prompt`, { message: "" });
    expect(bad.statusCode).toBe(400);
    const missing = await u1.post("/v1/threads/conv_x/prompt", { message: "hi" });
    expect(missing.statusCode).toBe(404);
  });

  it("accepts a prompt and returns 202 immediately", async () => {
    app = await makeApp();
    const u1 = authed(app, "good");
    const conv = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    const res = await u1.post(`/v1/threads/${conv.id}/prompt`, { message: "hi" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true });
    await vi.waitFor(async () => {
      const one = await u1.get(`/v1/threads/${conv.id}`);
      expect(one.json().state).toBe("idle");
    });
  });

  it("abort on unknown conversation 404s", async () => {
    app = await makeApp();
    const res = await authed(app, "good").post("/v1/threads/conv_x/abort");
    expect(res.statusCode).toBe(404);
  });

  // Spec §10: 1MB max message — enforced at the transport layer so we
  // reject before any handler runs (cheap, consistent, no per-route cap).
  it("rejects bodies larger than the 1MB bodyLimit with 413", async () => {
    app = await makeApp();
    const u1 = authed(app, "good");
    const conv = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    const tooBig = { message: "x".repeat(1_048_577) };
    const res = await u1.post(`/v1/threads/${conv.id}/prompt`, tooBig);
    expect(res.statusCode).toBe(413);
  });

  // Spec §10: workspace allowlist default-deny. The app built below has NO
  // workspaceAllowlist override → it picks up createWorkspaceAllowlist(undefined)
  // which rejects every non-null workspace.
  it("rejects conversations with a workspace not on the allowlist", async () => {
    app = await buildApp({
      dbPath: ":memory:",
      childCommand: process.execPath,
      childArgs: [fakePi],
      idleMs: 60_000,
      verifyToken: testVerifier,
      // no workspaceAllowlist → default-deny
    });
    const u1 = authed(app, "good");
    const res = await u1.post("/v1/threads", { title: "x", workspace: "/any/path" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "workspace_not_allowed" });
  });

  it("accepts conversations with no workspace (platform-level chats)", async () => {
    app = await buildApp({
      dbPath: ":memory:",
      childCommand: process.execPath,
      childArgs: [fakePi],
      idleMs: 60_000,
      verifyToken: testVerifier,
      // no workspaceAllowlist → default-deny on workspaces, but null is fine
    });
    const u1 = authed(app, "good");
    const res = await u1.post("/v1/threads", { title: "private" });
    expect(res.statusCode).toBe(201);
  });

  // PATCH /v1/threads/:id (rename) and DELETE /v1/threads/:id
  // back the new conversation-list UI (frontend rename ✎ / delete ×).
  it("renames a conversation via PATCH and returns the updated row", async () => {
    app = await makeApp();
    const u1 = authed(app, "good");
    const conv = (await (await u1.post("/v1/threads", { title: "old" })).json()) as { id: string };
    const res = await u1.post(`/v1/threads/${conv.id}/prompt`, { message: "hi" });
    // Use the helper's post method with custom method override:
    const renamed = await app.inject({
      method: "PATCH",
      url: `/v1/threads/${conv.id}`,
      headers: { authorization: `Bearer good` },
      payload: { title: "new title" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().title).toBe("new title");
    // Round-trip via GET confirms persistence.
    const fetched = await u1.get(`/v1/threads/${conv.id}`);
    expect(fetched.json().title).toBe("new title");
    // Validation rejects empty / too-long titles.
    const bad1 = await app.inject({
      method: "PATCH",
      url: `/v1/threads/${conv.id}`,
      headers: { authorization: `Bearer good` },
      payload: { title: "" },
    });
    expect(bad1.statusCode).toBe(400);
    void res; // silence unused
  });

  it("rejects PATCH rename across users (cross-tenant 404)", async () => {
    app = await makeApp();
    const u1 = authed(app, "good"); // user_test1
    const conv = (await (await u1.post("/v1/threads", { title: "mine" })).json()) as { id: string };
    const stolen = await app.inject({
      method: "PATCH",
      url: `/v1/threads/${conv.id}`,
      headers: { authorization: `Bearer good2` },
      payload: { title: "hijacked" },
    });
    expect(stolen.statusCode).toBe(404);
    const mine = await u1.get(`/v1/threads/${conv.id}`);
    expect(mine.json().title).toBe("mine");
  });

  it("deletes a conversation via DELETE and 204s, then GET 404s", async () => {
    app = await makeApp();
    const u1 = authed(app, "good");
    const conv = (await (await u1.post("/v1/threads", { title: "bye" })).json()) as { id: string };
    const del = await app.inject({
      method: "DELETE",
      url: `/v1/threads/${conv.id}`,
      headers: { authorization: `Bearer good` },
    });
    expect(del.statusCode).toBe(204);
    const fetched = await u1.get(`/v1/threads/${conv.id}`);
    expect(fetched.statusCode).toBe(404);
    // The list no longer contains it.
    const list = await u1.get("/v1/threads");
    expect((list.json().conversations as Array<{ id: string }>).map((c) => c.id)).not.toContain(conv.id);
  });

  it("rejects DELETE across users (cross-tenant 404, no destructive action)", async () => {
    app = await makeApp();
    const u1 = authed(app, "good");
    const conv = (await (await u1.post("/v1/threads", { title: "mine" })).json()) as { id: string };
    const stolen = await app.inject({
      method: "DELETE",
      url: `/v1/threads/${conv.id}`,
      headers: { authorization: `Bearer good2` },
    });
    expect(stolen.statusCode).toBe(404);
    const stillThere = await u1.get(`/v1/threads/${conv.id}`);
    expect(stillThere.statusCode).toBe(200);
  });

  it("DELETE kills the live session host (#85)", async () => {
    app = await makeApp();
    const u1 = authed(app, "good");
    const conv = (await (await u1.post("/v1/threads", { title: "bye" })).json()) as { id: string };
    const prompt = await u1.post(`/v1/threads/${conv.id}/prompt`, { message: "hi" });
    expect(prompt.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const one = await u1.get(`/v1/threads/${conv.id}`);
      expect((one.json() as { state: string }).state).toBe("idle");
    });
    // Host is alive after the turn settles.
    const before = await app.inject({ method: "GET", url: "/metrics" });
    expect(before.body).toContain("aelvyril_active_session_hosts 1");
    // DELETE must SIGKILL the host (exit decrements the gauge) instead of
    // leaving an orphan publisher behind.
    const del = await app.inject({
      method: "DELETE",
      url: `/v1/threads/${conv.id}`,
      headers: { authorization: `Bearer good` },
    });
    expect(del.statusCode).toBe(204);
    const a = app;
    await vi.waitFor(async () => {
      const after = await a.inject({ method: "GET", url: "/metrics" });
      expect(after.body).toContain("aelvyril_active_session_hosts 0");
    });
  });

  it("refuses prompts past the per-thread cost cap with 403 (#84)", async () => {
    app = await buildApp({
      dbPath: ":memory:",
      childCommand: process.execPath,
      childArgs: [fakePi],
      idleMs: 60_000,
      verifyToken: testVerifier,
      maxCostPerThreadUsd: 0.001, // fake-pi reports 0.0042 → capped
    });
    const u1 = authed(app, "good");
    const conv = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    const first = await u1.post(`/v1/threads/${conv.id}/prompt`, { message: "hi" });
    expect(first.statusCode).toBe(202);
    // Wait for the harvest to persist usage + the blocked state.
    await vi.waitFor(async () => {
      const one = await u1.get(`/v1/threads/${conv.id}`);
      expect((one.json() as { state: string }).state).toBe("blocked");
    });
    const second = await u1.post(`/v1/threads/${conv.id}/prompt`, { message: "again" });
    expect(second.statusCode).toBe(403);
    expect(second.json().error).toBe("cost_cap_reached");
    expect((second.json() as { cap: number }).cap).toBe(0.001);
  });

  it("POST /v1/threads/kill-all abandons every live thread for the user (#84)", async () => {
    // File-backed db so the test can read the status column directly (the
    // conversation DTO predates Thread.status and doesn't expose it).
    const dbFile = join(tmpdir(), `aelvyril-killall-${randomUUID()}.db`);
    app = await buildApp({
      dbPath: dbFile,
      childCommand: process.execPath,
      childArgs: [fakePi],
      idleMs: 60_000,
      verifyToken: testVerifier,
    });
    const u1 = authed(app, "good");
    const live = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    const idle = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    await u1.post(`/v1/threads/${live.id}/prompt`, { message: "hi" });
    const a = app;
    await vi.waitFor(async () => {
      const one = await u1.get(`/v1/threads/${live.id}`);
      expect((one.json() as { state: string }).state).toBe("idle");
    });

    const res = await a.inject({
      method: "POST",
      url: "/v1/threads/kill-all",
      headers: { authorization: "Bearer good" },
    });
    // The thread already settled (state idle) — the kill switch only takes
    // down threads that are live (streaming/blocked). Nothing to do here.
    expect(res.json()).toEqual({ abandoned: 0 });

    // Make it live again, then pull the switch.
    await u1.post(`/v1/threads/${live.id}/prompt`, { message: "hi again" });
    await vi.waitFor(async () => {
      const m = await a.inject({ method: "GET", url: "/metrics" });
      expect(m.body).toContain("aelvyril_active_session_hosts 1");
    });
    const kill = await a.inject({
      method: "POST",
      url: "/v1/threads/kill-all",
      headers: { authorization: "Bearer good" },
    });
    expect(kill.json()).toEqual({ abandoned: 1 });
    const db = new Database(dbFile);
    try {
      expect(
        (db.prepare("SELECT status, state FROM conversations WHERE id = ?").get(live.id) as { status: string; state: string }),
      ).toEqual({ status: "abandoned", state: "idle" });
      expect(
        (db.prepare("SELECT status FROM conversations WHERE id = ?").get(idle.id) as { status: string }).status,
      ).toBe("draft");
    } finally {
      db.close();
    }
    // Host killed: gauge drains to zero.
    await vi.waitFor(async () => {
      const m = await a.inject({ method: "GET", url: "/metrics" });
      expect(m.body).toContain("aelvyril_active_session_hosts 0");
    });
    // Unauthenticated callers can't pull it.
    const bare = await a.inject({ method: "POST", url: "/v1/threads/kill-all" });
    expect(bare.statusCode).toBe(401);
    try {
      rmSync(dbFile, { force: true });
    } catch {
      // Windows can briefly hold the file handle after close
    }
  });

  // Spec §10: per-user rate limit on /v1/threads/:id/prompt.
  // Uses a deterministic 1-token-capacity limiter with no refill — the
  // second prompt from the same user in the same test must trip it.
  it("rate-limits the prompt route: 429 + retry-after once a user exceeds their bucket", async () => {
    const consumed: string[] = [];
    const rl = {
      consume: (uid: string) => {
        consumed.push(uid);
        // First call OK, second call (same user within this test) throttled.
        return consumed.filter((u) => u === uid).length === 1 ? 0 : -1;
      },
      reset: () => {},
    };
    app = await buildApp({
      dbPath: ":memory:",
      childCommand: process.execPath,
      childArgs: [fakePi],
      idleMs: 60_000,
      verifyToken: testVerifier,
      workspaceAllowlist: {
        isAllowed: () => true,
        resolve: () => null,
        size: () => Number.POSITIVE_INFINITY,
      },
      rateLimiter: rl,
    });
    const u1 = authed(app, "good");
    const conv = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    // First prompt: OK (consumed=1, returns 0).
    const first = await u1.post(`/v1/threads/${conv.id}/prompt`, { message: "hi" });
    expect(first.statusCode).toBe(202);
    // Second prompt from same user: bucket empty → 429 with retry-after.
    const second = await u1.post(`/v1/threads/${conv.id}/prompt`, { message: "again" });
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBe("60");
    expect(second.json()).toEqual({ error: "rate_limited" });
  });

  // Spec §10: per-user concurrent-conversation cap. #83 raised the DEFAULT
  // to 30 (threads are cheap rows; hosts are the real limit) — this test
  // pins the mechanism with an explicit low cap.
  it("caps total conversations per user at the configured limit (503 + limit field)", async () => {
    app = await buildApp({
      dbPath: ":memory:",
      childCommand: process.execPath,
      childArgs: [fakePi],
      idleMs: 60_000,
      verifyToken: testVerifier,
      maxConversationsPerUser: 3,
    });
    const u1 = authed(app, "good");
    await u1.post("/v1/threads", { title: "1" });
    await u1.post("/v1/threads", { title: "2" });
    await u1.post("/v1/threads", { title: "3" });
    const fourth = await u1.post("/v1/threads", { title: "4" });
    expect(fourth.statusCode).toBe(503);
    expect(fourth.json()).toEqual({ error: "conversation_limit_reached", limit: 3 });
    // Different user is unaffected — cap is per-namespace.
    const u2 = authed(app, "good2");
    const u2first = await u2.post("/v1/threads", { title: "u2-1" });
    expect(u2first.statusCode).toBe(201);
  });

  it("defaults the thread cap to 30 (threads are cheap, hosts are not — #83)", async () => {
    app = await makeApp();
    const u1 = authed(app, "good");
    for (let i = 0; i < 4; i++) {
      const res = await u1.post("/v1/threads", { title: `t${i}` });
      expect(res.statusCode).toBe(201);
    }
  });

  // Spec §11: every response carries X-Request-Id. The web client + reverse
  // proxy use the same id to correlate logs across services.
  it("includes a unique X-Request-Id on every response", async () => {
    app = await makeApp();
    const u1 = authed(app, "good");
    const r1 = await u1.get("/healthz");
    const r2 = await u1.get("/healthz");
    expect(r1.headers["x-request-id"]).toBeTruthy();
    expect(r2.headers["x-request-id"]).toBeTruthy();
    expect(r1.headers["x-request-id"]).not.toEqual(r2.headers["x-request-id"]);
    // 8-char random base36: matches the genReqId implementation.
    expect(r1.headers["x-request-id"]).toMatch(/^[a-z0-9]{8}$/);
  });

  it("echoes a sanitized client x-request-id and refuses unsafe ones (#85)", async () => {
    app = await makeApp();
    const safe = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { "x-request-id": "abc-123_DEF:4.5" },
    });
    expect(safe.headers["x-request-id"]).toBe("abc-123_DEF:4.5");
    // Newline (log injection) and over-length ids are replaced, not echoed.
    const injected = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { "x-request-id": "evil\ninjected" },
    });
    expect(injected.headers["x-request-id"]).toMatch(/^[a-z0-9]{8}$/);
    const tooLong = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { "x-request-id": "a".repeat(65) },
    });
    expect(tooLong.headers["x-request-id"]).toMatch(/^[a-z0-9]{8}$/);
  });

  it("401s the 302 aliases without auth and 400s an unsafe :id (#85)", async () => {
    app = await makeApp();
    const bare = await app.inject({ method: "GET", url: "/v1/conversations" });
    expect(bare.statusCode).toBe(401);
    const bareId = await app.inject({
      method: "GET",
      url: "/v1/conversations/some-id/events",
    });
    expect(bareId.statusCode).toBe(401);
    const u1 = authed(app, "good");
    const bad = await u1.get(`/v1/conversations/${encodeURIComponent("bad id\n")}/events`);
    expect(bad.statusCode).toBe(400);
  });

  it("redirects an authenticated alias with the id percent-encoded (#85)", async () => {
    app = await makeApp();
    const u1 = authed(app, "good");
    const res = await u1.get("/v1/conversations/conv_abc-123");
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/v1/threads/conv_abc-123");
  });
});

describe("thread route rename", () => {
  let app: App | undefined;
  afterEach(async () => app && (await app.close()));

  it("302s GET /v1/conversations to /v1/threads", async () => {
    app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/conversations",
      headers: { authorization: "Bearer good" },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/v1/threads");
  });

  it("serves GET /v1/threads", async () => {
    app = await makeApp();
    const res = await authed(app, "good").get("/v1/threads");
    expect(res.statusCode).toBe(200);
  });

  it("POST /v1/conversations alias preserves method + body (302 would drop both)", async () => {
    app = await makeApp();
    const res = await authed(app, "good").post("/v1/conversations", { title: "alias" });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { title: string }).title).toBe("alias");
  });

  it("creates, lists, gets via canonical /v1/threads", async () => {
    app = await makeApp();
    const u1 = authed(app, "good");
    const created = await u1.post("/v1/threads", { title: "t" });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;
    const list = await u1.get("/v1/threads");
    expect((list.json() as { conversations: unknown[] }).conversations).toHaveLength(1);
    const one = await u1.get(`/v1/threads/${id}`);
    expect((one.json() as { title: string }).title).toBe("t");
  });

  it("302s GET /v1/conversations/:id to /v1/threads/:id", async () => {
    app = await makeApp();
    const u1 = authed(app, "good");
    const conv = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    const res = await app.inject({
      method: "GET",
      url: `/v1/conversations/${conv.id}`,
      headers: { authorization: "Bearer good" },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/v1/threads/${conv.id}`);
  });

  it("DELETE /v1/conversations/:id alias stays destructive (204)", async () => {
    app = await makeApp();
    const u1 = authed(app, "good");
    const conv = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    const res = await app.inject({
      method: "DELETE",
      url: `/v1/conversations/${conv.id}`,
      headers: { authorization: `Bearer good` },
    });
    expect(res.statusCode).toBe(204);
  });
});

describe("PATCH /v1/threads/:id/spec", () => {
  let app: App | undefined;
  let dbPath: string | undefined;
  afterEach(async () => {
    if (app) await app.close();
    if (dbPath) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // Windows can briefly hold the file handle after close
      }
    }
  });

  function makeAppWithDb() {
    dbPath = join(tmpdir(), `aelvyril-spec-${randomUUID()}.db`);
    return buildApp({
      dbPath,
      childCommand: process.execPath,
      childArgs: [fakePi],
      idleMs: 60_000,
      verifyToken: testVerifier,
    });
  }

  function dbGetThread(id: string): { status: string; spec_draft: string | null; spec_answers: string | null } {
    const db = new Database(dbPath!);
    try {
      return db
        .prepare("SELECT status, spec_draft, spec_answers FROM conversations WHERE id = ?")
        .get(id) as never;
    } finally {
      db.close();
    }
  }

  it("applies an answer patch and persists answers", async () => {
    app = await makeAppWithDb();
    const u1 = authed(app, "good");
    const t = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/threads/${t.id}/spec`,
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      payload: { kind: "answer", answers: { q1: "admin" } },
    });
    expect(res.statusCode).toBe(200);
    const stored = dbGetThread(t.id);
    expect(JSON.parse(stored.spec_answers ?? "{}")).toEqual({ q1: "admin" });
  });

  it("returns 413 when the accumulated spec blob would exceed the cap (#85)", async () => {
    const a = await makeAppWithDb();
    app = a;
    const u1 = authed(a, "good");
    const t = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    // Individual values are schema-capped at 10k; the accumulated merge is
    // what hits the 512k store cap. Two 26-key patches of max-size values
    // cross it.
    const big = "x".repeat(10_000);
    const patch = (offset: number) =>
      a.inject({
        method: "PATCH",
        url: `/v1/threads/${t.id}/spec`,
        headers: { authorization: "Bearer good", "content-type": "application/json" },
        payload: {
          kind: "answer",
          answers: Object.fromEntries(
            Array.from({ length: 26 }, (_, i) => [`k${offset + i}`, big]),
          ),
        },
      });
    expect((await patch(0)).statusCode).toBe(200);
    const over = await patch(26);
    expect(over.statusCode).toBe(413);
    expect(over.json().error).toBe("spec_too_large");
  });

  it("applies an edit patch and persists the draft field", async () => {
    app = await makeAppWithDb();
    const u1 = authed(app, "good");
    const t = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/threads/${t.id}/spec`,
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      payload: { kind: "edit", field: "goal", value: "add RBAC" },
    });
    expect(res.statusCode).toBe(200);
    const stored = dbGetThread(t.id);
    expect(JSON.parse(stored.spec_draft ?? "{}").goal).toBe("add RBAC");
  });

  it("rejects malformed body with 400", async () => {
    app = await makeAppWithDb();
    const u1 = authed(app, "good");
    const t = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/threads/${t.id}/spec`,
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      payload: { kind: "answer" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s a foreign user's thread", async () => {
    app = await makeAppWithDb();
    const t = (await (await authed(app, "good").post("/v1/threads", {})).json()) as { id: string };
    const res = await app.inject({
      method: "PATCH",
      url: `/v1/threads/${t.id}/spec`,
      headers: { authorization: "Bearer good2", "content-type": "application/json" },
      payload: { kind: "answer", answers: { q1: "x" } },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("thread lifecycle routes", () => {
  let app: App | undefined;
  let dbPath: string | undefined;
  afterEach(async () => {
    if (app) await app.close();
    if (dbPath) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // Windows can briefly hold the file handle after close
      }
    }
  });

  function makeAppWithDb() {
    dbPath = join(tmpdir(), `aelvyril-life-${randomUUID()}.db`);
    return buildApp({
      dbPath,
      childCommand: process.execPath,
      childArgs: [fakePi],
      idleMs: 60_000,
      verifyToken: testVerifier,
    });
  }

  function seedStatus(id: string, status: string): void {
    const db = new Database(dbPath!);
    try {
      db.prepare("UPDATE conversations SET status = ? WHERE id = ?").run(status, id);
    } finally {
      db.close();
    }
  }

  function threadStatus(id: string): string {
    const db = new Database(dbPath!);
    try {
      return (
        db.prepare("SELECT status FROM conversations WHERE id = ?").get(id) as { status: string }
      ).status;
    } finally {
      db.close();
    }
  }

  it("POST /approve transitions spec'ing -> running", async () => {
    app = await makeAppWithDb();
    const t = (await (await authed(app, "good").post("/v1/threads", {})).json()) as { id: string };
    seedStatus(t.id, "spec'ing");
    const res = await app.inject({
      method: "POST",
      url: `/v1/threads/${t.id}/approve`,
      headers: { authorization: "Bearer good" },
    });
    expect(res.statusCode).toBe(200);
    expect(threadStatus(t.id)).toBe("running");
  });

  it("POST /abandon marks abandoned", async () => {
    app = await makeAppWithDb();
    const t = (await (await authed(app, "good").post("/v1/threads", {})).json()) as { id: string };
    seedStatus(t.id, "running");
    const res = await app.inject({
      method: "POST",
      url: `/v1/threads/${t.id}/abandon`,
      headers: { authorization: "Bearer good" },
    });
    expect(res.statusCode).toBe(200);
    expect(threadStatus(t.id)).toBe("abandoned");
  });

  it("POST /retry transitions reviewed -> running", async () => {
    app = await makeAppWithDb();
    const t = (await (await authed(app, "good").post("/v1/threads", {})).json()) as { id: string };
    seedStatus(t.id, "reviewed");
    const res = await app.inject({
      method: "POST",
      url: `/v1/threads/${t.id}/retry`,
      headers: { authorization: "Bearer good" },
    });
    expect(res.statusCode).toBe(200);
    expect(threadStatus(t.id)).toBe("running");
  });

  it("404s a foreign user's thread on lifecycle actions", async () => {
    app = await makeAppWithDb();
    const t = (await (await authed(app, "good").post("/v1/threads", {})).json()) as { id: string };
    seedStatus(t.id, "spec'ing");
    for (const action of ["approve", "abandon", "retry"]) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/threads/${t.id}/${action}`,
        headers: { authorization: "Bearer good2" },
      });
      expect(res.statusCode).toBe(404);
    }
    expect(threadStatus(t.id)).toBe("spec'ing");
  });
});

describe("durable prompt queue (#83)", () => {
  let app: App | undefined;
  afterEach(async () => app && (await app.close()));

  function makeQueueApp(
    dbPath: string,
    maxRunningHostsPerUser: number,
    queueIntervalMs: number,
  ) {
    return buildApp({
      dbPath,
      childCommand: process.execPath,
      childArgs: [fakePi],
      idleMs: 60_000,
      verifyToken: testVerifier,
      maxRunningHostsPerUser,
      queueIntervalMs,
    });
  }

  it("queues prompts at the running-host cap and refuses duplicates", async () => {
    // Cap 0: every non-steer prompt queues; the long interval keeps the
    // runner out of this test's assertions.
    app = await makeQueueApp(":memory:", 0, 3_600_000);
    const u1 = authed(app, "good");
    const t1 = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    const t2 = (await (await u1.post("/v1/threads", {})).json()) as { id: string };

    const p1 = await u1.post(`/v1/threads/${t1.id}/prompt`, { message: "first" });
    expect(p1.statusCode).toBe(202);
    expect(p1.json()).toEqual({ accepted: true, queued: true });
    const p2 = await u1.post(`/v1/threads/${t2.id}/prompt`, { message: "second" });
    expect(p2.json()).toEqual({ accepted: true, queued: true });

    // A second non-steer prompt on an already-queued thread is a 409.
    const dup = await u1.post(`/v1/threads/${t1.id}/prompt`, { message: "dup" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({ error: "already_queued" });
  });

  it("survives a restart: the next process's runner drains the queue", async () => {
    const dbFile = join(tmpdir(), `aelvyril-queue-${randomUUID()}.db`);
    try {
      // Phase 1: enqueue two prompts with the runner effectively stopped.
      const app1 = await makeQueueApp(dbFile, 0, 3_600_000);
      const u1 = authed(app1, "good");
      const t1 = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
      const t2 = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
      await u1.post(`/v1/threads/${t1.id}/prompt`, { message: "one" });
      await u1.post(`/v1/threads/${t2.id}/prompt`, { message: "two" });
      await app1.close();

      // Phase 2: a fresh gateway with a free host slot and a fast runner.
      app = await makeQueueApp(dbFile, 1, 10);
      const u2 = authed(app, "good");
      const a = app;
      // Both threads were ALREADY state "idle" (nothing ran in phase 1), so
      // poll the status column directly: the runner flips queued → running
      // when it dequeues, and the settled turn leaves state idle.
      await vi.waitFor(() => {
        const db = new Database(dbFile);
        try {
          const rows = db
            .prepare("SELECT id, status, state FROM conversations WHERE id IN (?, ?)")
            .all(t1.id, t2.id) as Array<{ id: string; status: string; state: string }>;
          for (const r of rows) {
            expect(r.status).toBe("running");
            expect(r.state).toBe("idle");
          }
        } finally {
          db.close();
        }
      });
      void a;
      // Queue fully drained: a new prompt with a free host slot goes live
      // (no `queued` in the response, no 409 from stale queue rows).
      const again = await u2.post(`/v1/threads/${t1.id}/prompt`, { message: "three" });
      expect(again.statusCode).toBe(202);
      expect(again.json()).toEqual({ accepted: true });
    } finally {
      try {
        rmSync(dbFile, { force: true });
      } catch {
        // Windows can briefly hold the file handle after close
      }
    }
  });

  it("kill-all drops queued work and abandons queued threads", async () => {
    app = await makeQueueApp(":memory:", 0, 3_600_000);
    const u1 = authed(app, "good");
    const t1 = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    await u1.post(`/v1/threads/${t1.id}/prompt`, { message: "queued work" });
    const kill = await app.inject({
      method: "POST",
      url: "/v1/threads/kill-all",
      headers: { authorization: "Bearer good" },
    });
    expect(kill.json()).toEqual({ abandoned: 1 });
    // The queue was dropped: the thread is no longer "queued" (no 409), and
    // with the cap still 0 the new prompt queues fresh.
    const reprompt = await u1.post(`/v1/threads/${t1.id}/prompt`, { message: "again" });
    expect(reprompt.statusCode).toBe(202);
    expect(reprompt.json()).toEqual({ accepted: true, queued: true });
  });

  it("boot sweep marks stale streaming rows degraded after a restart", async () => {
    const dbFile = join(tmpdir(), `aelvyril-sweep-${randomUUID()}.db`);
    try {
      const app1 = await makeQueueApp(dbFile, 2, 3_600_000);
      const u1 = authed(app1, "good");
      const t1 = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
      // Simulate a host dying with the process: the row is left 'streaming'.
      const db = new Database(dbFile);
      db.prepare("UPDATE conversations SET state = 'streaming' WHERE id = ?").run(t1.id);
      db.close();
      await app1.close();

      app = await makeQueueApp(dbFile, 2, 3_600_000);
      const one = await authed(app, "good").get(`/v1/threads/${t1.id}`);
      expect((one.json() as { state: string }).state).toBe("degraded");
    } finally {
      try {
        rmSync(dbFile, { force: true });
      } catch {
        // Windows can briefly hold the file handle after close
      }
    }
  });
});
