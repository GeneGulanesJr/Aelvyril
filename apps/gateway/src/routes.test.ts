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

  // Spec §10: per-user concurrent-conversation cap (v1: 3/user).
  it("caps total conversations per user at 3 (503 + limit field on the 4th)", async () => {
    app = await makeApp();
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
