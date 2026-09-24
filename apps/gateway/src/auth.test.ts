import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import type { App } from "./app.js";
import type { TokenVerifier } from "./auth.js";

const fakePi = fileURLToPath(new URL("../fixtures/fake-pi.mjs", import.meta.url));

const okVerifier: TokenVerifier = async (token) =>
  token === "good" || token === "good2" ? { userId: `user_${token}` } : null;

// helper: authenticated request helpers used across this file
function authed(app: App, token: string) {
  return {
    get: (url: string) =>
      app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } }),
    post: (url: string, payload?: Record<string, unknown>) =>
      app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload }),
  };
}

describe("auth", () => {
  it("401s /v1 routes without a token", async () => {
    const app = await buildApp({
      dbPath: ":memory:",
      childCommand: process.execPath,
      childArgs: [fakePi],
      verifyToken: okVerifier,
    });
    const res = await app.inject({ method: "GET", url: "/v1/threads" });
    expect(res.statusCode).toBe(401);
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    await app.close();
  });

  it("401s on a bad token", async () => {
    const app = await buildApp({
      dbPath: ":memory:",
      childCommand: process.execPath,
      childArgs: [fakePi],
      verifyToken: okVerifier,
    });
    const res = await authed(app, "nope").get("/v1/threads");
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("scopes conversations per namespace (spec §2)", async () => {
    const app = await buildApp({
      dbPath: ":memory:",
      childCommand: process.execPath,
      childArgs: [fakePi],
      // two-token verifier on ONE app: "good" -> user_test1, "good2" -> user_test2
      verifyToken: async (token) =>
        token === "good"
          ? { userId: "user_test1" }
          : token === "good2"
            ? { userId: "user_test2" }
            : null,
    });
    const u1 = authed(app, "good");
    const u2 = authed(app, "good2");
    await u1.post("/v1/threads", { title: "mine" });
    const mine = await u1.get("/v1/threads");
    expect(mine.json().conversations).toHaveLength(1);
    const theirs = await u2.get("/v1/threads");
    expect(theirs.json().conversations).toHaveLength(0);
    await app.close();
  });

  it("rejects cross-user access to another user's conversation", async () => {
    const app = await buildApp({
      dbPath: ":memory:",
      childCommand: process.execPath,
      childArgs: [fakePi],
      verifyToken: async (token) =>
        token === "ta" ? { userId: "user_A" } : token === "tb" ? { userId: "user_B" } : null,
    });
    const conv = (await (await authed(app, "ta").post("/v1/threads", {})).json()) as {
      id: string;
    };
    const stolen = await authed(app, "tb").get(`/v1/threads/${conv.id}`);
    expect(stolen.statusCode).toBe(404);
    const mine = await authed(app, "ta").get(`/v1/threads/${conv.id}`);
    expect(mine.statusCode).toBe(200);
    await app.close();
  });
});
