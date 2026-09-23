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
    const created = await u1.post("/v1/conversations", { title: "t", workspace: "LaPis" });
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
});
