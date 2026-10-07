import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import type { App } from "./app.js";
import { isLoopbackHost, type TokenVerifier } from "./auth.js";

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

  it("gates /metrics with the scrape secret when configured (#85)", async () => {
    const app = await buildApp({
      dbPath: ":memory:",
      childCommand: process.execPath,
      childArgs: [fakePi],
      verifyToken: okVerifier,
      metricsSecret: "s3cret",
    });
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/metrics",
          headers: { authorization: "Bearer wrong" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/metrics",
          headers: { authorization: "Bearer s3cret" },
        })
      ).statusCode,
    ).toBe(200);
    await app.close();
  });

  // Review P3: /metrics is fail-closed now — with no secret and no explicit
  // metricsPublic opt-in, it answers 401 instead of being open by default.
  it("closes /metrics by default: 401 unless metricsPublic is explicitly true", async () => {
    const app = await buildApp({
      dbPath: ":memory:",
      childCommand: process.execPath,
      childArgs: [fakePi],
      verifyToken: okVerifier,
    });
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(401);
    await app.close();
  });
});

describe("isLoopbackHost (#78)", () => {
  it("accepts loopback spellings only", () => {
    for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "127.9.9.9", "::1", "[::1]", " ::1 "]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    // All-interfaces and hostname spellings are network-exposed.
    for (const host of ["::", "0.0.0.0", "", "192.168.1.10", "gateway.example.com", "[::]", "*"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("admin route authorization (#76)", () => {
  const fakeStatus = {
    currentSha: "a".repeat(40),
    currentShort: "aaaaaaa",
    remoteSha: "b".repeat(40),
    remoteShort: "bbbbbbb",
    behind: 1,
    fetchedAt: new Date().toISOString(),
    repoPath: "/tmp/repo",
  };

  // Stub flows: the real ones run git + spawn a detached restart script —
  // never acceptable in tests. The stubs also count calls so the 403 tests
  // can prove the guard runs BEFORE any update side effect.
  function makeAdminApp(adminUserIds?: string[]) {
    const calls = { status: 0, apply: 0 };
    const built = buildApp({
      dbPath: ":memory:",
      childCommand: process.execPath,
      childArgs: [fakePi],
      verifyToken: okVerifier,
      adminUserIds,
      updateStatus: async () => {
        calls.status++;
        return fakeStatus;
      },
      applyUpdate: async () => {
        calls.apply++;
        return { started: true, message: "stubbed" };
      },
    });
    return { built, calls };
  }

  it("401s /v1/admin/* without a bearer token", async () => {
    const { built } = makeAdminApp(["user_good"]);
    const app = await built;
    expect((await app.inject({ method: "GET", url: "/v1/admin/update/status" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/admin/update" })).statusCode).toBe(401);
    await app.close();
  });

  it("403s an authenticated non-admin and never reaches the updater", async () => {
    const { built, calls } = makeAdminApp(["user_good2"]); // admin is user_test2
    const app = await built;
    const status = await authed(app, "good").get("/v1/admin/update/status");
    expect(status.statusCode).toBe(403);
    expect(status.json()).toEqual({ error: "forbidden" });
    const apply = await authed(app, "good").post("/v1/admin/update");
    expect(apply.statusCode).toBe(403);
    expect(calls.status).toBe(0);
    expect(calls.apply).toBe(0);
    await app.close();
  });

  it("default-denies when no admin allowlist is configured", async () => {
    const { built, calls } = makeAdminApp();
    const app = await built;
    expect((await authed(app, "good").get("/v1/admin/update/status")).statusCode).toBe(403);
    expect((await authed(app, "good").post("/v1/admin/update")).statusCode).toBe(403);
    expect(calls.apply).toBe(0);
    await app.close();
  });

  it("admits an allowlisted admin on both routes", async () => {
    const { built, calls } = makeAdminApp(["user_good"]);
    const app = await built;
    const status = await authed(app, "good").get("/v1/admin/update/status");
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ behind: 1, currentShort: "aaaaaaa" });
    const apply = await authed(app, "good").post("/v1/admin/update");
    expect(apply.statusCode).toBe(202);
    expect(apply.json()).toMatchObject({ started: true });
    expect(calls.status).toBe(1);
    expect(calls.apply).toBe(1);
    await app.close();
  });
});
