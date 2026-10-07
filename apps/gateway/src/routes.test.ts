import { afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    // /metrics is fail-closed by default (review P3); these CRUD/gauge tests
    // scrape it unauthenticated.
    metricsPublic: true,
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
    // Slow the fake child's deltas so a prompted turn is mid-stream (not
    // yet settled) when the switch is pulled — no timing race.
    process.env.FAKE_DELAY_MS = "300";
    try {
      app = await buildApp({
        dbPath: dbFile,
        childCommand: process.execPath,
        childArgs: [fakePi],
        idleMs: 60_000,
        verifyToken: testVerifier,
        metricsPublic: true,
        // FAKE_DELAY_MS must be explicitly allowlisted: children no longer
        // inherit the full process.env (review P1).
        childEnvAllowlist: ["FAKE_DELAY_MS"],
      });
      const u1 = authed(app, "good");
      const live = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
      const idle = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
      await u1.post(`/v1/threads/${live.id}/prompt`, { message: "hi" });
      const a = app;
      // The slowed fake turn takes ~1.3s (FAKE_DELAY_MS) — past the 1s
      // vi.waitFor default, so give it an explicit bound.
      await vi.waitFor(
        async () => {
          const one = await u1.get(`/v1/threads/${live.id}`);
          expect((one.json() as { state: string }).state).toBe("idle");
        },
        { timeout: 10_000 },
      );

      const res = await a.inject({
        method: "POST",
        url: "/v1/threads/kill-all",
        headers: { authorization: "Bearer good" },
      });
      // The thread already settled (state idle) — the kill switch only takes
      // down threads that are live (streaming/blocked). Nothing to do here.
      expect(res.json()).toEqual({ abandoned: 0 });

      // Make it live again, then pull the switch mid-stream. The gauge wait
      // is deterministic: the host stays alive ≥ idleMs after settling.
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
    } finally {
      delete process.env.FAKE_DELAY_MS;
      try {
        rmSync(dbFile, { force: true });
      } catch {
        // Windows can briefly hold the file handle after close
      }
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
      size: () => consumed.length,
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

  // #79: the gateway is an internal-only API — nosniff + never framed
  // (the CSP/frame-ancestors equivalent lives at the Caddy edge).
  it("sets x-content-type-options and x-frame-options on every response", async () => {
    app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
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

  // #80: approve drives a real execution prompt from the stored spec; the
  // seeds give the route something to rebuild from.
  function seedSpecDraft(id: string): void {
    const draft = {
      goal: "seeded",
      filesAffected: [],
      plan: ["edit src/a.ts"],
      risks: [],
      questions: [],
      answers: {},
    };
    const db = new Database(dbPath!);
    try {
      db.prepare("UPDATE conversations SET spec_draft = ? WHERE id = ?").run(JSON.stringify(draft), id);
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

  it("POST /approve with no spec is a 409 (#80: approve must have a plan)", async () => {
    app = await makeAppWithDb();
    const t = (await (await authed(app, "good").post("/v1/threads", {})).json()) as { id: string };
    seedStatus(t.id, "spec'ing");
    const res = await app.inject({
      method: "POST",
      url: `/v1/threads/${t.id}/approve`,
      headers: { authorization: "Bearer good" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_spec");
    expect(threadStatus(t.id)).toBe("spec'ing");
  });

  it("POST /approve sends the real execution prompt and flips to running (#80 fix 3)", async () => {
    app = await makeAppWithDb();
    const t = (await (await authed(app, "good").post("/v1/threads", {})).json()) as { id: string };
    seedStatus(t.id, "spec'ing");
    seedSpecDraft(t.id);
    const res = await app.inject({
      method: "POST",
      url: `/v1/threads/${t.id}/approve`,
      headers: { authorization: "Bearer good" },
    });
    expect(res.statusCode).toBe(200);
    expect(threadStatus(t.id)).toBe("running");
    // The host was spawned and accepted the execution prompt: the turn runs
    // (fixture Hello-world) and usage lands — proof a REAL prompt was sent,
    // not the old empty-map no-op.
    await vi.waitFor(async () => {
      const one = await authed(app!, "good").get(`/v1/threads/${t.id}`);
      expect((one.json() as { state: string }).state).toBe("idle");
      expect((one.json() as { usage: { cost: number } | null }).usage).not.toBeNull();
    });
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

  it("POST /retry re-executes the last prompt and counts the revision (#80 fix 3)", async () => {
    app = await makeAppWithDb();
    const u1 = authed(app, "good");
    const t = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    // A real prompt first — retry needs something to re-execute.
    await u1.post(`/v1/threads/${t.id}/prompt`, { message: "original ask" });
    await vi.waitFor(async () => {
      const one = await u1.get(`/v1/threads/${t.id}`);
      expect((one.json() as { state: string }).state).toBe("idle");
    });
    seedStatus(t.id, "reviewed");
    const res = await app.inject({
      method: "POST",
      url: `/v1/threads/${t.id}/retry`,
      headers: { authorization: "Bearer good" },
    });
    expect(res.statusCode).toBe(200);
    expect(threadStatus(t.id)).toBe("running");
    const db = new Database(dbPath!);
    try {
      expect(
        (db.prepare("SELECT retry_count FROM conversations WHERE id = ?").get(t.id) as { retry_count: number })
          .retry_count,
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it("POST /retry with nothing to re-execute is a 409", async () => {
    app = await makeAppWithDb();
    const t = (await (await authed(app, "good").post("/v1/threads", {})).json()) as { id: string };
    seedStatus(t.id, "reviewed");
    const res = await app.inject({
      method: "POST",
      url: `/v1/threads/${t.id}/retry`,
      headers: { authorization: "Bearer good" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("nothing_to_retry");
  });

  // #80 fix 5: the merged producer + trust escalation (#81.3).
  it("POST /merge transitions reviewed -> merged and records trust", async () => {
    app = await makeAppWithDb();
    const u1 = authed(app, "good");
    const t = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    // Not reviewable yet.
    seedStatus(t.id, "running");
    const early = await app.inject({
      method: "POST",
      url: `/v1/threads/${t.id}/merge`,
      headers: { authorization: "Bearer good" },
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe("not_reviewable");
    // Reviewed (no retry in between) → merged + trust++.
    seedStatus(t.id, "reviewed");
    const ok = await app.inject({
      method: "POST",
      url: `/v1/threads/${t.id}/merge`,
      headers: { authorization: "Bearer good" },
    });
    expect(ok.statusCode).toBe(200);
    expect(threadStatus(t.id)).toBe("merged");
    const db = new Database(dbPath!);
    try {
      expect(
        (db.prepare("SELECT merged_without_revision FROM trust WHERE namespace = ?").get("user:user_test1") as {
          merged_without_revision: number;
        }).merged_without_revision,
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it("POST /merge after a retry does NOT record trust (#81.3)", async () => {
    app = await makeAppWithDb();
    const u1 = authed(app, "good");
    const t = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    await u1.post(`/v1/threads/${t.id}/prompt`, { message: "ask" });
    await vi.waitFor(async () => {
      const one = await u1.get(`/v1/threads/${t.id}`);
      expect((one.json() as { state: string }).state).toBe("idle");
    });
    seedStatus(t.id, "reviewed");
    await app.inject({
      method: "POST",
      url: `/v1/threads/${t.id}/retry`,
      headers: { authorization: "Bearer good" },
    });
    seedStatus(t.id, "reviewed");
    const ok = await app.inject({
      method: "POST",
      url: `/v1/threads/${t.id}/merge`,
      headers: { authorization: "Bearer good" },
    });
    expect(ok.statusCode).toBe(200);
    const db = new Database(dbPath!);
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM trust").get() as { n: number }).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("404s a foreign user's thread on lifecycle actions", async () => {
    app = await makeAppWithDb();
    const t = (await (await authed(app, "good").post("/v1/threads", {})).json()) as { id: string };
    seedStatus(t.id, "spec'ing");
    for (const action of ["approve", "abandon", "retry", "merge"]) {
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
      // when it dequeues, and the settled turn leaves state idle. Two node
      // spawns + turns can take seconds on a loaded machine (full-suite
      // parallel runs) — give the waitFor a generous bound.
      await vi.waitFor(
        () => {
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
        },
        { timeout: 20_000 },
      );
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

  it("abandon drops the thread's queued prompt (runner must not resurrect it, 2nd review)", async () => {
    app = await makeQueueApp(":memory:", 0, 3_600_000);
    const u1 = authed(app, "good");
    const t1 = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    const queued = await u1.post(`/v1/threads/${t1.id}/prompt`, { message: "queued work" });
    expect(queued.json()).toEqual({ accepted: true, queued: true });
    const abandon = await app.inject({
      method: "POST",
      url: `/v1/threads/${t1.id}/abandon`,
      headers: { authorization: "Bearer good" },
    });
    expect(abandon.statusCode).toBe(200);
    // The queued row was dropped with the thread: a new prompt queues fresh
    // instead of 409 already_queued, and the long runner interval guarantees
    // the abandoned thread is never started behind our backs.
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

// ---------------------------------------------------------------------------
// #80/#81/#82: the wired core loop, end to end through the HTTP surface.
// The fixture scripts the agent side (custom_spec_question / draft signals,
// gated tools, real file edits); the workspace is a real git repo so the
// gateway's diff producer sees genuine edits.
// ---------------------------------------------------------------------------

function git(dir: string, args: string[]): void {
  execFileSync("git", ["-C", dir, "-c", "user.email=a@b.c", "-c", "user.name=t", ...args], {
    stdio: "ignore",
  });
}

function tmpGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aelvyril-loop-"));
  git(dir, ["init"]);
  writeFileSync(join(dir, "base.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
  return dir;
}

function eventKinds(dbFile: string, conversationId: string): string[] {
  const db = new Database(dbFile);
  try {
    return (
      db
        .prepare("SELECT kind FROM events WHERE conversation_id = ? ORDER BY seq ASC")
        .all(conversationId) as Array<{ kind: string }>
    ).map((r) => r.kind);
  } finally {
    db.close();
  }
}

function eventPayloads(dbFile: string, conversationId: string, kind: string): unknown[] {
  const db = new Database(dbFile);
  try {
    return (
      db
        .prepare("SELECT payload FROM events WHERE conversation_id = ? AND kind = ? ORDER BY seq ASC")
        .all(conversationId, kind) as Array<{ payload: string }>
    ).map((r) => JSON.parse(r.payload));
  } finally {
    db.close();
  }
}

describe("wired core loop (#80 #81 #82)", () => {
  let app: App | undefined;
  let dbPath: string | undefined;
  let repo: string | undefined;
  const envBackup: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string): void {
    if (!(key in envBackup)) envBackup[key] = process.env[key];
    process.env[key] = value;
  }

  afterEach(async () => {
    if (app) await app.close();
    if (dbPath) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // Windows can briefly hold the file handle after close
      }
    }
    if (repo) {
      try {
        rmSync(repo, { recursive: true, force: true });
      } catch {
        // Windows file-handle lag
      }
    }
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      delete envBackup[key];
    }
    app = undefined;
    dbPath = undefined;
    repo = undefined;
  });

  async function makeLoopApp(verifyOverrides?: {
    exec: (command: string[], cwd: string, timeoutMs: number) => Promise<{ command: string; ok: boolean; output: string }>;
    retries?: number;
  }) {
    repo = tmpGitRepo();
    dbPath = join(tmpdir(), `aelvyril-core-${randomUUID()}.db`);
    app = await buildApp({
      dbPath,
      childCommand: process.execPath,
      childArgs: [fakePi],
      idleMs: 60_000,
      verifyToken: testVerifier,
      // Children no longer inherit the full process.env (review P1) — the
      // fixture knobs are explicitly allowlisted for these tests.
      childEnvAllowlist: [
        "FAKE_SPEC_QUESTIONS",
        "FAKE_PLAN_JSON",
        "FAKE_GATED_TOOL",
        "FAKE_EDIT_FILE",
        "FAKE_DELAY_MS",
        "FAKE_UI_DIALOG",
      ],
      workspaceAllowlist: {
        isAllowed: () => true,
        resolve: (w) => w ?? null,
        size: () => Number.POSITIVE_INFINITY,
      },
      verify: verifyOverrides
        ? { commandsOverride: "pnpm test", exec: verifyOverrides.exec, retries: verifyOverrides.retries }
        : undefined,
    });
    return app;
  }

  async function createAndPrompt(message: string, specMode: "auto" | "force" | "off") {
    const u1 = authed(app!, "good");
    const t = (await (await u1.post("/v1/threads", { workspace: repo! })).json()) as { id: string };
    const res = await u1.post(`/v1/threads/${t.id}/prompt`, { message, specMode });
    expect(res.statusCode).toBe(202);
    return t;
  }

  it("spec interview → answers → draft → auto-run → diff → reviewed → merged (#80, #81)", async () => {
    setEnv("FAKE_SPEC_QUESTIONS", "1");
    setEnv("FAKE_EDIT_FILE", "feature.ts");
    await makeLoopApp();
    const t = await createAndPrompt("add role-based access to the admin dashboard", "force");

    // 1. The agent asks (fixture), the gateway publishes spec_question.
    await vi.waitFor(() => {
      expect(eventKinds(dbPath!, t.id)).toContain("spec_question");
    });
    // 2. Answers are persisted AND forwarded to the live agent.
    const patch = await app!.inject({
      method: "PATCH",
      url: `/v1/threads/${t.id}/spec`,
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      payload: { kind: "answer", answers: { q1: "admin/editor/viewer" } },
    });
    expect(patch.statusCode).toBe(200);
    // 3. The fixture answers with a reversible draft → the contract
    //    AUTO-RUNS it (#81.1: no approval for reversible work)…
    await vi.waitFor(() => {
      expect(eventKinds(dbPath!, t.id)).toContain("spec_draft");
    });
    await vi.waitFor(() => {
      expect(eventPayloads(dbPath!, t.id, "spec_status").some((p) => (p as { status: string }).status === "running")).toBe(true);
    });
    // …the auto-run execution prompt really went to the agent (its turn
    // streams text), the gateway computed the REAL git diff of the
    // fixture's file write, and the thread landed in reviewed.
    await vi.waitFor(
      () => {
        const statuses = eventPayloads(dbPath!, t.id, "spec_status").map((p) => (p as { status: string }).status);
        expect(statuses).toContain("reviewed");
      },
      { timeout: 10_000 },
    );
    const diffPayload = eventPayloads(dbPath!, t.id, "diff").at(-1) as { files: Array<{ path: string }> };
    expect(diffPayload.files.map((f) => f.path)).toContain("feature.ts");
    const verdicts = eventPayloads(dbPath!, t.id, "laya_verdict") as Array<{
      tool: string;
      verdict: { stage: string; gated: boolean };
    }>;
    expect(verdicts.some((v) => v.verdict.stage === "plan" && v.verdict.gated === false)).toBe(true);

    // 4. Merge: reviewed → merged, trust recorded (#80 fix 5, #81.3).
    const merge = await app!.inject({
      method: "POST",
      url: `/v1/threads/${t.id}/merge`,
      headers: { authorization: "Bearer good" },
    });
    expect(merge.statusCode).toBe(200);
    await vi.waitFor(() => {
      const statuses = eventPayloads(dbPath!, t.id, "spec_status").map((p) => (p as { status: string }).status);
      expect(statuses.at(-1)).toBe("merged");
    });
    const db = new Database(dbPath!);
    try {
      expect(
        db.prepare("SELECT merged_without_revision FROM trust WHERE namespace = ?").get("user:user_test1") as {
          merged_without_revision: number;
        },
      ).toEqual({ merged_without_revision: 1 });
    } finally {
      db.close();
    }
  });

  it("a gated plan parks on approve; a gated tool mid-run stops the run (#81)", async () => {
    setEnv("FAKE_SPEC_QUESTIONS", "1");
    setEnv("FAKE_PLAN_JSON", JSON.stringify(["pnpm install left-pad", "edit src/a.ts"]));
    setEnv("FAKE_GATED_TOOL", "1");
    setEnv("FAKE_EDIT_FILE", "feature.ts");
    await makeLoopApp();
    const t = await createAndPrompt("add left-pad to the project", "force");

    await vi.waitFor(() => {
      expect(eventKinds(dbPath!, t.id)).toContain("spec_question");
    });
    await app!.inject({
      method: "PATCH",
      url: `/v1/threads/${t.id}/spec`,
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      payload: { kind: "answer", answers: { q1: "because" } },
    });
    // Draft lands with a gated plan → the thread PARKS (no auto-run).
    await vi.waitFor(() => {
      expect(eventKinds(dbPath!, t.id)).toContain("spec_draft");
    });
    const planVerdict = eventPayloads(dbPath!, t.id, "laya_verdict").find(
      (p) => (p as { verdict: { stage: string } }).verdict.stage === "plan",
    );
    expect(planVerdict).toMatchObject({ verdict: { gated: true } });
    await new Promise((r) => setTimeout(r, 200));
    expect(eventKinds(dbPath!, t.id)).not.toContain("diff"); // nothing ran

    // Approve → execution prompt → the fixture fires a gated bash tool →
    // the classifier stops the run and escalates blocked/gated.
    const approve = await app!.inject({
      method: "POST",
      url: `/v1/threads/${t.id}/approve`,
      headers: { authorization: "Bearer good" },
    });
    expect(approve.statusCode).toBe(200);
    await vi.waitFor(() => {
      const blocked = eventPayloads(dbPath!, t.id, "session_state").some(
        (p) => (p as { state: string; reason?: string }).state === "blocked" &&
          (p as { state: string; reason?: string }).reason === "gated",
      );
      expect(blocked).toBe(true);
    });
    const toolVerdicts = eventPayloads(dbPath!, t.id, "laya_verdict").filter(
      (p) => (p as { verdict: { stage: string } }).verdict.stage === "tool",
    ) as Array<{ verdict: { gated: boolean; allowed: boolean; cls: string } }>;
    expect(toolVerdicts.some((v) => v.verdict.gated && !v.verdict.allowed && v.verdict.cls === "irreversible")).toBe(true);
    const db = new Database(dbPath!);
    try {
      expect(
        (db.prepare("SELECT state FROM conversations WHERE id = ?").get(t.id) as { state: string }).state,
      ).toBe("blocked");
    } finally {
      db.close();
    }

    // Approve again: the reviewed gated action is allowed; the run proceeds
    // to completion and lands in reviewed with the real diff.
    const approve2 = await app!.inject({
      method: "POST",
      url: `/v1/threads/${t.id}/approve`,
      headers: { authorization: "Bearer good" },
    });
    expect(approve2.statusCode).toBe(200);
    await vi.waitFor(
      () => {
        const statuses = eventPayloads(dbPath!, t.id, "spec_status").map((p) => (p as { status: string }).status);
        expect(statuses).toContain("reviewed");
      },
      { timeout: 10_000 },
    );
    const allowedVerdicts = eventPayloads(dbPath!, t.id, "laya_verdict").filter(
      (p) => (p as { verdict: { stage: string; allowed?: boolean } }).verdict.stage === "tool",
    ) as Array<{ verdict: { allowed: boolean } }>;
    expect(allowedVerdicts.some((v) => v.verdict.allowed)).toBe(true);
  });

  it("auto-verify feeds failures back with a bounded budget (#82)", async () => {
    // Fresh repo with a pre-edit so the diff is non-empty without fixture
    // flags; a verify exec that fails exactly once.
    repo = tmpGitRepo();
    writeFileSync(join(repo!, "base.txt"), "edited before prompt\n");
    dbPath = join(tmpdir(), `aelvyril-core-${randomUUID()}.db`);
    const execCalls: string[] = [];
    let failFirst = true;
    const exec = async (command: string[]) => {
      execCalls.push(command.join(" "));
      if (failFirst) {
        failFirst = false;
        return { command: command.join(" "), ok: false, output: "42 tests failed" };
      }
      return { command: command.join(" "), ok: true, output: "all green" };
    };
    app = await buildApp({
      dbPath,
      childCommand: process.execPath,
      childArgs: [fakePi],
      idleMs: 60_000,
      verifyToken: testVerifier,
      workspaceAllowlist: {
        isAllowed: () => true,
        resolve: (w) => w ?? null,
        size: () => Number.POSITIVE_INFINITY,
      },
      verify: { commandsOverride: "pnpm test", exec, retries: 3 },
    });
    const t = await createAndPrompt("fix the failing thing", "off");

    // First settle → verify fails → the failure goes BACK to the agent
    // (bounded self-retry) instead of waiting for a human.
    await vi.waitFor(
      () => {
        expect(execCalls.length).toBeGreaterThanOrEqual(1);
        const errors = eventPayloads(dbPath!, t.id, "error") as Array<{ code?: string; message: string }>;
        expect(errors.some((e) => e.code === "verify_failed")).toBe(true);
      },
      { timeout: 10_000 },
    );
    // The retry prompt really reached the child: the fixture runs another
    // turn and settles again → verify passes → reviewed.
    await vi.waitFor(
      () => {
        const statuses = eventPayloads(dbPath!, t.id, "spec_status").map((p) => (p as { status: string }).status);
        expect(statuses).toContain("reviewed");
      },
      { timeout: 10_000 },
    );
    expect(execCalls.length).toBe(2);
    expect(execCalls.every((c) => c === "pnpm test")).toBe(true);
  });

  it("verify budget exhaustion escalates WITH failure context attached (#82)", async () => {
    repo = tmpGitRepo();
    writeFileSync(join(repo!, "base.txt"), "edited before prompt\n");
    dbPath = join(tmpdir(), `aelvyril-core-${randomUUID()}.db`);
    let calls = 0;
    const exec = async (command: string[]) => {
      calls++;
      return { command: command.join(" "), ok: false, output: `still broken (call ${calls})` };
    };
    app = await buildApp({
      dbPath,
      childCommand: process.execPath,
      childArgs: [fakePi],
      idleMs: 60_000,
      verifyToken: testVerifier,
      workspaceAllowlist: {
        isAllowed: () => true,
        resolve: (w) => w ?? null,
        size: () => Number.POSITIVE_INFINITY,
      },
      verify: { commandsOverride: "pnpm test", exec, retries: 2 },
    });
    const t = await createAndPrompt("fix the failing thing", "off");
    await vi.waitFor(
      () => {
        const errors = eventPayloads(dbPath!, t.id, "error") as Array<{ code?: string; message: string }>;
        expect(errors.some((e) => e.code === "verify_exhausted")).toBe(true);
      },
      { timeout: 15_000 },
    );
    // Budget: retries=2 → attempts 1,2 feed back; attempt 3 escalates.
    expect(calls).toBe(3);
    const exhausted = (eventPayloads(dbPath!, t.id, "error") as Array<{ code?: string; message: string }>).find(
      (e) => e.code === "verify_exhausted",
    )!;
    expect(exhausted.message).toContain("still broken");
    const statuses = eventPayloads(dbPath!, t.id, "spec_status").map((p) => (p as { status: string }).status);
    expect(statuses).toContain("reviewed");
  });

  it("specMode rides to the agent: force wraps, off does not (#80 fix 2)", async () => {
    // Supervisor-level assertion via the events: FAKE_SPEC_QUESTIONS makes
    // the fixture ask on the FIRST prompt regardless; the observable
    // gateway-side contract is wrapPrompt, covered in agent-contract tests.
    // Here we pin the ROUTE plumbing: a force prompt with the fixture in
    // interview mode produces spec_question without any gateway error, and
    // an off prompt completes a plain turn with no spec envelopes.
    await makeLoopApp();
    const u1 = authed(app!, "good");
    const tOff = (await (await u1.post("/v1/threads", { workspace: repo! })).json()) as { id: string };
    const res = await u1.post(`/v1/threads/${tOff.id}/prompt`, { message: "plain ask", specMode: "off" });
    expect(res.statusCode).toBe(202);
    await vi.waitFor(async () => {
      const one = await u1.get(`/v1/threads/${tOff.id}`);
      expect((one.json() as { state: string }).state).toBe("idle");
    });
    const kinds = eventKinds(dbPath!, tOff.id);
    expect(kinds).not.toContain("spec_question");
    expect(kinds).not.toContain("spec_status");
  });
});

// ---------------------------------------------------------------------------
// Review fixes 3+4+6: cap enforcement on the steer path, runner steer
// semantics for live targets, and 502 + degraded on supervisor RPC failures.
// ---------------------------------------------------------------------------

/**
 * A STRICT fake agent: rejects a bare prompt (no streamingBehavior) while a
 * turn is mid-flight — exactly pi's shared-schema behavior that used to flip
 * live threads degraded/reviewed when the queue runner re-sent without
 * steer. Turn length is driven by the message ("long …" → 400ms) so the
 * runner-vs-turn interleavings are deterministic. Accepts steer mid-turn
 * (the turn runs after the current one) and reports each executed turn via
 * a custom envelope.
 */
async function writeStrictFixture(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "aelvyril-strict-"));
  const file = join(dir, "strict-pi.mjs");
  writeFileSync(
    file,
    `import readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on("line", (l) => lines.push(l));
async function readLine() { while (lines.length === 0) await sleep(2); return lines.shift(); }
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let busy = false;
const pending = [];
async function turn(message) {
  await sleep(message.startsWith("long") ? 400 : 80);
  send({ type: "custom_turn_ran", value: message });
  send({ type: "agent_settled" });
}
async function drain() { while (pending.length) await turn(pending.shift()); busy = false; }
async function main() {
  for (;;) {
    const line = await readLine();
    if (!line.trim()) continue;
    const cmd = JSON.parse(line);
    if (cmd.type === "prompt") {
      if (busy && !cmd.streamingBehavior) {
        send({ id: cmd.id, type: "response", command: "prompt", success: false, error: "busy_without_streaming_behavior" });
        continue;
      }
      send({ id: cmd.id, type: "response", command: "prompt", success: true });
      if (busy) { pending.push(String(cmd.message ?? "")); continue; }
      busy = true;
      turn(String(cmd.message ?? "")).then(drain);
      continue;
    }
    send({ id: cmd.id, type: "response", command: String(cmd.type), success: true });
  }
}
main();
`,
  );
  return file;
}

describe("steer-path caps + rpc failure handling (review fixes 3, 4, 6)", () => {
  let app: App | undefined;
  let dbPath: string | undefined;
  let fixtureDirs: string[] = [];

  afterEach(async () => {
    if (app) await app.close();
    if (dbPath) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // Windows file-handle lag
      }
    }
    for (const d of fixtureDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    app = undefined;
    dbPath = undefined;
    fixtureDirs = [];
  });

  // Review fix 3: a streamingBehavior prompt with NO live host used to
  // bypass the running-host caps entirely (spawning an untracked host).
  it("queues a steer with no live host when the user is at cap (no bypass)", async () => {
    app = await buildApp({
      dbPath: ":memory:",
      childCommand: process.execPath,
      childArgs: [fakePi],
      idleMs: 60_000,
      verifyToken: testVerifier,
      maxRunningHostsPerUser: 0,
      queueIntervalMs: 3_600_000, // runner off — the queue must hold it
    });
    const u1 = authed(app, "good");
    const t = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    const res = await u1.post(`/v1/threads/${t.id}/prompt`, {
      message: "steer into the void",
      streamingBehavior: "steer",
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true, queued: true });
  });

  // Review fix 4 (route half): at-cap queueing must pass through when the
  // TARGET thread itself is live.
  it("passes a plain prompt to a live target through with steer semantics instead of queueing", async () => {
    const fixture = await writeStrictFixture();
    fixtureDirs.push(dirname(fixture));
    dbPath = join(tmpdir(), `aelvyril-steer-live-${randomUUID()}.db`);
    app = await buildApp({
      dbPath,
      childCommand: process.execPath,
      childArgs: [fixture],
      idleMs: 60_000,
      verifyToken: testVerifier,
      maxRunningHostsPerUser: 1, // the live target consumes the whole budget
      queueIntervalMs: 3_600_000, // runner off — pass-through must not need it
    });
    const u1 = authed(app, "good");
    const t = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    expect((await u1.post(`/v1/threads/${t.id}/prompt`, { message: "long running turn" })).statusCode).toBe(202);
    // The target is live and the user is at cap: the old code queued this;
    // the new code steers the live host.
    const second = await u1.post(`/v1/threads/${t.id}/prompt`, { message: "me too" });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual({ accepted: true }); // not queued
    // The strict fixture ACCEPTED the steer (a bare prompt mid-turn would
    // have been rejected → 502) and ran the steered turn after the first.
    // Values are prefix-matched: the contract wraps prompts with the spec
    // protocol preamble, so the fixture echoes the wrapped text.
    await vi.waitFor(
      () => {
        expect(
          eventPayloads(dbPath!, t.id, "custom").some(
            (p) =>
              (p as { type?: string; data?: { value?: string } }).type === "custom_turn_ran" &&
              String((p as { type?: string; data?: { value?: string } }).data?.value).startsWith("me too"),
          ),
        ).toBe(true);
      },
      { timeout: 10_000 },
    );
    await vi.waitFor(async () => {
      const one = await u1.get(`/v1/threads/${t.id}`);
      expect((one.json() as { state: string }).state).toBe("idle");
    });
  }, 20_000);

  // Review fix 4 (runner half): a dequeued prompt for a live, BUSY thread
  // must carry steer semantics — a bare prompt gets schema-rejected, which
  // used to flip the thread degraded/reviewed.
  it("runner sends steer to a thread that went live between enqueue and dequeue", async () => {
    const fixture = await writeStrictFixture();
    fixtureDirs.push(dirname(fixture));
    dbPath = join(tmpdir(), `aelvyril-runner-steer-${randomUUID()}.db`);
    app = await buildApp({
      dbPath,
      childCommand: process.execPath,
      childArgs: [fixture],
      idleMs: 60_000,
      verifyToken: testVerifier,
      maxRunningHostsPerUser: 2,
      queueIntervalMs: 10,
    });
    const u1 = authed(app, "good");
    const a = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    const b = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    // A runs short, B runs long — when A settles the runner wakes, finds a
    // free slot, and dequeues the row below while B is still mid-turn.
    expect((await u1.post(`/v1/threads/${a.id}/prompt`, { message: "short" })).statusCode).toBe(202);
    expect((await u1.post(`/v1/threads/${b.id}/prompt`, { message: "long turn" })).statusCode).toBe(202);
    // Simulate the stale queue row for B (a restart survivor). Inserted
    // directly — the route can no longer enqueue for a live thread.
    const db = new Database(dbPath);
    let namespace: string;
    try {
      namespace = (
        db.prepare("SELECT namespace FROM conversations WHERE id = ?").get(b.id) as { namespace: string }
      ).namespace;
      db.prepare(
        "INSERT INTO prompt_queue(conversation_id, namespace, message, spec_mode, created_at) VALUES(?, ?, ?, 'off', ?)",
      ).run(b.id, namespace, "follow-up work", new Date().toISOString());
    } finally {
      db.close();
    }
    // A settles (~80ms) → the runner dequeues B's row while B is busy
    // (~400ms). Steer semantics must get it ACCEPTED. (Prefix match: the
    // contract wraps the prompt, so the fixture echoes the wrapped text.)
    await vi.waitFor(
      () => {
        expect(
          eventPayloads(dbPath!, b.id, "custom").some(
            (p) =>
              (p as { type?: string; data?: { value?: string } }).type === "custom_turn_ran" &&
              String((p as { type?: string; data?: { value?: string } }).data?.value).startsWith("follow-up work"),
          ),
        ).toBe(true);
      },
      { timeout: 10_000 },
    );
    // …and the rejection path must NOT have fired.
    const errors = eventPayloads(dbPath!, b.id, "error") as Array<{ message?: string }>;
    expect(errors.some((e) => String(e.message ?? "").includes("rejected by the agent"))).toBe(false);
    await vi.waitFor(async () => {
      const one = await u1.get(`/v1/threads/${b.id}`);
      expect((one.json() as { state: string }).state).toBe("idle");
    });
  }, 20_000);

  // Review fix 6: supervisor RPC failures must 502 agent_rejected, bump
  // promptRejections, and leave a non-running state instead of a stuck
  // 'running' row until the idle reaper.
  it("502s agent_rejected + degrades the thread when the host dies mid-send (prompt)", async () => {
    app = await buildApp({
      dbPath: ":memory:",
      childCommand: process.execPath,
      childArgs: ["-e", "process.exit(1)"], // host dies instantly
      idleMs: 60_000,
      verifyToken: testVerifier,
      metricsPublic: true,
    });
    const u1 = authed(app, "good");
    const t = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    const res = await u1.post(`/v1/threads/${t.id}/prompt`, { message: "hi" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "agent_rejected" });
    const one = await u1.get(`/v1/threads/${t.id}`);
    expect((one.json() as { state: string }).state).toBe("degraded");
    const m = await app.inject({ method: "GET", url: "/metrics" });
    expect(m.body).toMatch(/aelvyril_prompt_rejections_total\s+1/);
  });

  it("502s agent_rejected + reverts status when the host dies mid-send (retry)", async () => {
    app = await buildApp({
      dbPath: ":memory:",
      childCommand: process.execPath,
      childArgs: ["-e", "process.exit(1)"],
      idleMs: 60_000,
      verifyToken: testVerifier,
      metricsPublic: true,
    });
    const u1 = authed(app, "good");
    const t = (await (await u1.post("/v1/threads", {})).json()) as { id: string };
    // A failed prompt still persisted lastPrompt — retry has something to
    // re-send, then dies at the RPC layer.
    expect((await u1.post(`/v1/threads/${t.id}/prompt`, { message: "hi" })).statusCode).toBe(502);
    const retry = await u1.post(`/v1/threads/${t.id}/retry`);
    expect(retry.statusCode).toBe(502);
    expect(retry.json()).toEqual({ error: "agent_rejected" });
    const one = await u1.get(`/v1/threads/${t.id}`);
    expect((one.json() as { state: string }).state).toBe("degraded");
    const m = await app.inject({ method: "GET", url: "/metrics" });
    expect(m.body).toMatch(/aelvyril_prompt_rejections_total\s+2/);
  });
});
