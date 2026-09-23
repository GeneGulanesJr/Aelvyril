import { afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
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
    const created = await u1.post("/v1/conversations", { title: "t", workspace: "/home/LaPis" });
    expect(created.statusCode).toBe(201);
    const conv = created.json();
    expect(conv.id).toMatch(/^conv_/);

    const list = await u1.get("/v1/conversations");
    expect(list.json().conversations).toHaveLength(1);

    const one = await u1.get(`/v1/conversations/${conv.id}`);
    expect(one.json().title).toBe("t");

    const missing = await u1.get("/v1/conversations/conv_x");
    expect(missing.statusCode).toBe(404);
  });

  it("validates prompt body", async () => {
    app = await makeApp();
    const u1 = authed(app, "good");
    const conv = (await (await u1.post("/v1/conversations", {})).json()) as { id: string };
    const bad = await u1.post(`/v1/conversations/${conv.id}/prompt`, { message: "" });
    expect(bad.statusCode).toBe(400);
    const missing = await u1.post("/v1/conversations/conv_x/prompt", { message: "hi" });
    expect(missing.statusCode).toBe(404);
  });

  it("accepts a prompt and returns 202 immediately", async () => {
    app = await makeApp();
    const u1 = authed(app, "good");
    const conv = (await (await u1.post("/v1/conversations", {})).json()) as { id: string };
    const res = await u1.post(`/v1/conversations/${conv.id}/prompt`, { message: "hi" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true });
    await vi.waitFor(async () => {
      const one = await u1.get(`/v1/conversations/${conv.id}`);
      expect(one.json().state).toBe("idle");
    });
  });

  it("abort on unknown conversation 404s", async () => {
    app = await makeApp();
    const res = await authed(app, "good").post("/v1/conversations/conv_x/abort");
    expect(res.statusCode).toBe(404);
  });

  // Spec §10: 1MB max message — enforced at the transport layer so we
  // reject before any handler runs (cheap, consistent, no per-route cap).
  it("rejects bodies larger than the 1MB bodyLimit with 413", async () => {
    app = await makeApp();
    const u1 = authed(app, "good");
    const conv = (await (await u1.post("/v1/conversations", {})).json()) as { id: string };
    const tooBig = { message: "x".repeat(1_048_577) };
    const res = await u1.post(`/v1/conversations/${conv.id}/prompt`, tooBig);
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
    const res = await u1.post("/v1/conversations", { title: "x", workspace: "/any/path" });
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
    const res = await u1.post("/v1/conversations", { title: "private" });
    expect(res.statusCode).toBe(201);
  });

  // PATCH /v1/conversations/:id (rename) and DELETE /v1/conversations/:id
  // back the new conversation-list UI (frontend rename ✎ / delete ×).
  it("renames a conversation via PATCH and returns the updated row", async () => {
    app = await makeApp();
    const u1 = authed(app, "good");
    const conv = (await (await u1.post("/v1/conversations", { title: "old" })).json()) as { id: string };
    const res = await u1.post(`/v1/conversations/${conv.id}/prompt`, { message: "hi" });
    // Use the helper's post method with custom method override:
    const renamed = await app.inject({
      method: "PATCH",
      url: `/v1/conversations/${conv.id}`,
      headers: { authorization: `Bearer good` },
      payload: { title: "new title" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().title).toBe("new title");
    // Round-trip via GET confirms persistence.
    const fetched = await u1.get(`/v1/conversations/${conv.id}`);
    expect(fetched.json().title).toBe("new title");
    // Validation rejects empty / too-long titles.
    const bad1 = await app.inject({
      method: "PATCH",
      url: `/v1/conversations/${conv.id}`,
      headers: { authorization: `Bearer good` },
      payload: { title: "" },
    });
    expect(bad1.statusCode).toBe(400);
    void res; // silence unused
  });

  it("rejects PATCH rename across users (cross-tenant 404)", async () => {
    app = await makeApp();
    const u1 = authed(app, "good"); // user_test1
    const u2 = authed(app, "good2"); // user_test2
    const conv = (await (await u1.post("/v1/conversations", { title: "mine" })).json()) as { id: string };
    const stolen = await app.inject({
      method: "PATCH",
      url: `/v1/conversations/${conv.id}`,
      headers: { authorization: `Bearer good2` },
      payload: { title: "hijacked" },
    });
    expect(stolen.statusCode).toBe(404);
    const mine = await u1.get(`/v1/conversations/${conv.id}`);
    expect(mine.json().title).toBe("mine");
  });

  it("deletes a conversation via DELETE and 204s, then GET 404s", async () => {
    app = await makeApp();
    const u1 = authed(app, "good");
    const conv = (await (await u1.post("/v1/conversations", { title: "bye" })).json()) as { id: string };
    const del = await app.inject({
      method: "DELETE",
      url: `/v1/conversations/${conv.id}`,
      headers: { authorization: `Bearer good` },
    });
    expect(del.statusCode).toBe(204);
    const fetched = await u1.get(`/v1/conversations/${conv.id}`);
    expect(fetched.statusCode).toBe(404);
    // The list no longer contains it.
    const list = await u1.get("/v1/conversations");
    expect((list.json().conversations as Array<{ id: string }>).map((c) => c.id)).not.toContain(conv.id);
  });

  it("rejects DELETE across users (cross-tenant 404, no destructive action)", async () => {
    app = await makeApp();
    const u1 = authed(app, "good");
    const u2 = authed(app, "good2");
    const conv = (await (await u1.post("/v1/conversations", { title: "mine" })).json()) as { id: string };
    const stolen = await app.inject({
      method: "DELETE",
      url: `/v1/conversations/${conv.id}`,
      headers: { authorization: `Bearer good2` },
    });
    expect(stolen.statusCode).toBe(404);
    const stillThere = await u1.get(`/v1/conversations/${conv.id}`);
    expect(stillThere.statusCode).toBe(200);
  });
});
