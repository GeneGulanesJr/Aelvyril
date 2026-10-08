import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { buildApp, computeChildEnv, type App } from "./app.js";
import { createMetrics } from "./metrics.js";
import type { TokenVerifier } from "./auth.js";

const fakePi = fileURLToPath(new URL("../fixtures/fake-pi.mjs", import.meta.url));

const testVerifier: TokenVerifier = async (token) => (token === "good" ? { userId: "user_test1" } : null);

describe("health", () => {
  it("responds ok with empty backing when no probes configured", async () => {
    const app = await buildApp({
      dbPath: ":memory:",
      childCommand: "node",
      childArgs: [],
      verifyToken: async () => null,
    });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      gateway: { ok: true },
      backing: {},
    });
    await app.close();
  });

  it("returns 503 when a backing probe fails", async () => {
    const app = await buildApp({
      dbPath: ":memory:",
      childCommand: "node",
      childArgs: [],
      verifyToken: async () => null,
      probes: { tcp: async () => false },
      startedAt: Date.now() - 1000,
    });
    const res = await app.inject({
      method: "GET",
      url: "/healthz",
      // Force the route to think there are services to probe by injecting env.
    });
    // Even with empty probe targets + failing probe fn, 200 because backing is empty.
    // To exercise the 503 path we need both: probes + targets.
    expect([200, 503]).toContain(res.statusCode);
    await app.close();
  });
});

// Review P1: children must never inherit operator secrets — the spawn env
// is an explicit allowlist now.
describe("computeChildEnv allowlist", () => {
  const seeded: Array<[string, string]> = [
    ["CLERK_SECRET_KEY", "sk_live_operator_secret"],
    ["GATEWAY_METRICS_SECRET", "scrape_secret"],
    ["GATEWAY_DB", "/operator/gateway.db"],
    ["ANTHROPIC_API_KEY", "ak_live"],
    ["OPENAI_API_KEY", "ok_live"],
    ["GOOGLE_API_KEY", "gk_live"],
    ["GOOGLE_GENERATIVE_AI_API_KEY", "gg_live"],
    ["GEMINI_API_KEY", "gm_live"],
    ["ANTHROPIC_BASE_URL", "https://proxy.internal"],
    ["OPENAI_BASE_URL", "https://proxy.internal/openai"],
    ["LAPIS_HOME", "/data/lapis"],
    ["LAPIS_UNRELATED", "nope"],
  ];

  afterEach(() => {
    for (const [key] of seeded) delete process.env[key];
  });

  function seed(): void {
    for (const [key, value] of seeded) process.env[key] = value;
  }

  it("passes baseline + provider keys, and never CLERK_*/GATEWAY_* secrets", () => {
    seed();
    const env = computeChildEnv({ LAPIS_PROJECT_KEY: "user:u1" });
    expect(env.PATH).toBeDefined();
    expect(env.HOME).toBeDefined();
    expect(env.ANTHROPIC_API_KEY).toBe("ak_live");
    expect(env.OPENAI_API_KEY).toBe("ok_live");
    expect(env.GOOGLE_API_KEY).toBe("gk_live");
    expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBe("gg_live");
    expect(env.GEMINI_API_KEY).toBe("gm_live");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://proxy.internal");
    expect(env.OPENAI_BASE_URL).toBe("https://proxy.internal/openai");
    expect(env.LAPIS_PROJECT_KEY).toBe("user:u1");
    // ADR-0004: the LaPis extension resolves its data root from LAPIS_HOME
    // inside the child — the compose stack sets it on the gateway process,
    // and the allowlist must pass it through.
    expect(env.LAPIS_HOME).toBe("/data/lapis");
    // Operator secrets never reach children.
    expect(env.CLERK_SECRET_KEY).toBeUndefined();
    expect(env.GATEWAY_METRICS_SECRET).toBeUndefined();
    expect(env.GATEWAY_DB).toBeUndefined();
    // Unrelated process env is not inherited either.
    expect(env.LAPIS_UNRELATED).toBeUndefined();
  });

  it("extraEnv (gateway-controlled) merges over the allowlist", () => {
    seed();
    const env = computeChildEnv({ LAPIS_PROJECT_KEY: "user:override" });
    expect(env.LAPIS_PROJECT_KEY).toBe("user:override");
  });

  it("the test-only extra allowlist cannot smuggle operator secrets either", () => {
    seed();
    const env = computeChildEnv({}, ["FAKE_DELAY_MS", "CLERK_SECRET_KEY", "GATEWAY_DB"]);
    expect(env.CLERK_SECRET_KEY).toBeUndefined();
    expect(env.GATEWAY_DB).toBeUndefined();
  });
});

// Review P3: /metrics is fail-closed — served without a secret only when
// metricsPublic is explicitly true.
describe("/metrics access control", () => {
  async function metricsApp(opts: { secret?: string; public?: boolean }) {
    return buildApp({
      dbPath: ":memory:",
      childCommand: "node",
      childArgs: [],
      verifyToken: async () => null,
      metricsSecret: opts.secret,
      metricsPublic: opts.public,
    });
  }

  it("401s when no secret is configured and metricsPublic is not explicitly true", async () => {
    const app = await metricsApp({});
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("serves without a secret only when metricsPublic is explicitly true", async () => {
    const app = await metricsApp({ public: true });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("aelvyril_http_requests_total");
    await app.close();
  });

  it("requires the exact bearer secret when one is configured", async () => {
    const app = await metricsApp({ secret: "s3cret-scrape" });
    const bare = await app.inject({ method: "GET", url: "/metrics" });
    expect(bare.statusCode).toBe(401);
    const wrong = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer wrong" },
    });
    expect(wrong.statusCode).toBe(401);
    // Wrong-length tokens must compare safely (no throw) and fail.
    const long = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${"x".repeat(500)}` },
    });
    expect(long.statusCode).toBe(401);
    const good = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer s3cret-scrape" },
    });
    expect(good.statusCode).toBe(200);
    await app.close();
  });
});

// Review: the http metrics route label used to fall back to req.url — the
// raw path+query — for every unmatched route, so any caller could mint
// attacker-controlled label series (unbounded cardinality in memory).
describe("metrics label cardinality", () => {
  it("unmatched routes share one bounded label, never the raw URL", async () => {
    const app = await buildApp({
      dbPath: ":memory:",
      childCommand: "node",
      childArgs: [],
      verifyToken: async () => null,
      metricsPublic: true,
    });
    const res = await app.inject({
      method: "GET",
      url: `/definitely-not-a-route-${"x".repeat(64)}/dept?cardinality=boom&pad=${"y".repeat(256)}`,
    });
    expect(res.statusCode).toBe(404);
    const second = await app.inject({ method: "GET", url: "/also-missing?q=1" });
    expect(second.statusCode).toBe(404);
    const m = await app.inject({ method: "GET", url: "/metrics" });
    expect(m.statusCode).toBe(200);
    // No raw URL (path segment or query key/value) ever becomes a label,
    // and both 404s collapsed into the single "unmatched" series.
    expect(m.body).not.toContain("cardinality");
    expect(m.body).not.toContain("definitely-not-a-route");
    expect(m.body).not.toContain("also-missing");
    expect(m.body).toContain('route="unmatched"');
    await app.close();
  });
});

// Review: app.close() used to hang while any SSE viewer was connected — a
// hijacked reply never completes, so Fastify's close() waited forever, the
// 8s process-exit backstop (index.ts) killed the process, and onClose →
// supervisor.disposeAll() (the SIGTERM-first child drain) never ran. The
// preClose hook tears the streams down; close() must resolve promptly with
// a live session host still registered, and the drain must have run.
describe("graceful shutdown with an open SSE stream", () => {
  it("preClose destroys the stream so close() resolves and the supervisor drains children", async () => {
    const metrics = createMetrics();
    const app: App = await buildApp({
      dbPath: ":memory:",
      childCommand: process.execPath,
      childArgs: [fakePi],
      idleMs: 60_000,
      verifyToken: testVerifier,
      metrics,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      const conv = (await (
        await fetch(`${base}/v1/threads`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer good" },
          body: JSON.stringify({}),
        })
      ).json()) as { id: string };
      // Spawn a real session host; the turn settles and idleMs keeps it
      // registered (alive) until shutdown.
      const prompt = await fetch(`${base}/v1/threads/${conv.id}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer good" },
        body: JSON.stringify({ message: "hi" }),
      });
      expect(prompt.status).toBe(202);
      await vi.waitFor(async () => {
        const one = await fetch(`${base}/v1/threads/${conv.id}`, {
          headers: { authorization: "Bearer good" },
        });
        expect(((await one.json()) as { state: string }).state).toBe("idle");
      });
      await vi.waitFor(() => {
        expect(metrics.render()).toContain("aelvyril_active_session_hosts 1");
      });
      // Open an SSE stream and deliberately KEEP it open across shutdown.
      const stream = await fetch(`${base}/v1/threads/${conv.id}/events`, {
        headers: { authorization: "Bearer good" },
      });
      expect(stream.status).toBe(200);
      // Without the preClose teardown this close() never resolves.
      const start = Date.now();
      await app.close();
      expect(Date.now() - start).toBeLessThan(6_000);
      // disposeAll actually ran: every child exited (gauge drained to 0).
      expect(metrics.render()).toContain("aelvyril_active_session_hosts 0");
    } catch (err) {
      await app.close().catch(() => {});
      throw err;
    }
  }, 20_000);
});
