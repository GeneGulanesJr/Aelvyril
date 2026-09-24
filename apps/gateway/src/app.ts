import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { spawn } from "node:child_process";
import {
  CreateConversationBody,
  PatchSpecBody,
  PromptBody,
  RenameConversationBody,
  toUserNamespace,
  type EventEnvelope,
} from "@aelvyril/shared";
import { Store } from "./store.js";
import { EventBus } from "./bus.js";
import { Supervisor } from "./supervisor.js";
import type { AgentContract } from "./agent-contract.js";
import type { TokenVerifier } from "./auth.js";
import { createWorkspaceAllowlist, type WorkspaceAllowlist } from "./workspace-allowlist.js";
import { createRateLimiter, type RateLimiter } from "./rate-limit.js";
import { createMetrics, type Metrics } from "./metrics.js";
import { runHealthCheck, defaultServiceProbes, type BackingServiceProbes } from "./health.js";
import { getUpdateStatus, applyUpdate } from "./updater.js";

export interface AppOptions {
  dbPath: string;
  childCommand: string;
  childArgs: string[];
  idleMs?: number;
  verifyToken: TokenVerifier;
  allowedOrigins?: string[];
  /** Optional workspace allowlist override for tests. Defaults to a default-deny list. */
  workspaceAllowlist?: WorkspaceAllowlist;
  /** Optional rate-limiter override for tests. Defaults to 20 req/min/user. */
  rateLimiter?: RateLimiter;
  /** Max total conversations per user (spec §10). Default 3. */
  maxConversationsPerUser?: number;
  /** Optional metrics override for tests. Defaults to a fresh in-memory registry. */
  metrics?: Metrics;
  /** Optional logger override for tests. Defaults to silent (logger: false). */
  logger?: boolean;
  /** Optional backing-service probe override for tests. Defaults to TCP probes via env. */
  probes?: BackingServiceProbes;
  /** Started-at timestamp used by the /healthz uptime field. */
  startedAt?: number;
  /** Disable compression middleware (tests / explicit opt-out). */
  compress?: boolean;
  /** SSE keepalive interval in ms (spec §6 heartbeat). Defaults to 15_000. */
  sseHeartbeatMs?: number;
}

export type App = FastifyInstance;

export async function buildApp(opts: AppOptions): Promise<App> {
  // Spec §10: 1MB max message. Fastify defaults to 1MB anyway, but we set it
  // explicitly so the value lives in the code (not in the runtime default) and
  // so the test asserts the contract instead of an implementation accident.
  // Pino (bundled with Fastify) emits structured JSON logs by default in
  // production. Tests opt out via opts.logger = false.
  // requestIdHeader: every response carries X-Request-Id. The web client +
  // reverse proxy can grep the same id across web + gateway + downstream
  // services for log correlation.
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 1_048_576,
    // With logger: false Fastify installs a null logger — per-request logs
    // are silent already (tests + GATEWAY_LOG=silent dev). No logController
    // override: Fastify 5.12 validates it must be a real LogController
    // instance and rejects plain objects at startup.
    genReqId: () => Math.random().toString(36).slice(2, 10),
    requestIdHeader: "x-request-id",
  });
  const store = new Store(opts.dbPath);
  const bus = new EventBus(store);
  // Spec §10: default-deny workspace allowlist. Override via opts in tests.
  const workspaceAllowlist = opts.workspaceAllowlist ?? createWorkspaceAllowlist(process.env.GATEWAY_WORKSPACE_ALLOWLIST);
  // Spec §10: per-user rate limit on /v1/conversations/:id/prompt.
  // 20 requests/min = capacity 20, refill 20/60 tokens/sec.
  const rateLimiter = opts.rateLimiter ?? createRateLimiter({
    capacity: 20,
    refillPerSecond: 20 / 60,
  });
  const maxConversationsPerUser = opts.maxConversationsPerUser ?? 3;
  const metrics = opts.metrics ?? createMetrics();
  const supervisor = new Supervisor({
    bus,
    store,
    spawnChild: (_conversationId, extraEnv, cwd) =>
      spawn(opts.childCommand, opts.childArgs, {
        env: { ...process.env, ...extraEnv },
        cwd,
      }),
    idleMs: opts.idleMs ?? 300_000,
    onSessionHostSpawn: () => metrics.activeSessionHosts.inc(),
    onSessionHostExit: () => metrics.activeSessionHosts.dec(),
  });

  const unauthorized = (reply: FastifyReply) => reply.code(401).send({ error: "unauthorized" });
  async function user(req: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return void unauthorized(reply);
    const user = await opts.verifyToken(header.slice(7));
    if (!user) return void unauthorized(reply);
    return user.userId;
  }

  // CORS before routes so preflight/headers apply to every /v1 handler.
  await app.register(import("@fastify/cors"), {
    origin: opts.allowedOrigins ?? false,
    credentials: true,
  });

  // Spec §11: gzip + zstd compression on JSON responses. SSE streams
  // (text/event-stream) are excluded by @fastify/compress by default —
  // compressing them would buffer the whole stream and break Last-Event-ID
  // reconnect semantics. Tests opt out via opts.compress.
  if (opts.compress !== false) {
    await app.register(import("@fastify/compress"), {
      global: true,
      threshold: 1_024,
      encodings: ["gzip", "deflate", "identity"],
    });
  }

  // Echo the request id on every response so the web client + reverse
  // proxy can correlate a single user request across web + gateway +
  // downstream pi child logs. Fastify's requestIdHeader is for INCOMING
  // requests; for the outgoing echo we need an explicit onSend hook.
  app.addHook("onSend", async (req, reply) => {
    if (req.id) reply.header("x-request-id", req.id);
  });

  // Spec §11: request-level metrics. onResponse fires after the route
  // handler has set reply.statusCode, so we capture the final response code.
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url ?? req.url;
    const labels = { method: req.method, route, status: String(reply.statusCode) };
    metrics.httpRequestsTotal.inc(labels);
    metrics.httpRequestDurationMs.observe(
      reply.elapsedTime ?? Date.now() - (req as { startTime?: number }).startTime!,
      labels,
    );
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof Error && err.name === "ZodError") {
      return reply.code(400).send({ error: "bad_request" });
    }
    throw err;
  });

  // Spec §9 + §11: probe backing services so K8s readiness reflects real
  // dependency state. Defaults to no probes (env opt-in); tests override
  // via opts.probes. Returns 503 if any probe fails — readiness check fails
  // until the dep is reachable.
  const startedAt = opts.startedAt ?? Date.now();
  app.get("/healthz", async (_req, reply) => {
    const result = await runHealthCheck(
      {
        probes: opts.probes,
        serviceProbes: opts.probes ? () => ({}) : defaultServiceProbes,
      },
      startedAt,
    );
    const allOk = result.gateway.ok && Object.values(result.backing).every((s) => s.ok);
    return reply.code(allOk ? 200 : 503).send(result);
  });

  // Prometheus text format. Unauthenticated by design (Prometheus scrapes
  // internally; an external scraper should go through the reverse proxy
  // which gates /metrics on its own network policy).
  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4");
    return metrics.render();
  });

  // Spec §11: manual update flow. Self-hosted convenience — any
  // signed-in user can check for + apply upstream commits. For a multi-
  // tenant SaaS, gate behind a Clerk Organizations admin role.
  app.get("/v1/admin/update/status", async (req, reply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    try {
      return await getUpdateStatus();
    } catch (err) {
      return reply.code(503).send({ error: "update_status_failed", message: String(err) });
    }
  });

  app.post("/v1/admin/update", async (req, reply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    try {
      const result = await applyUpdate();
      // The applyUpdate subprocess will SIGTERM us in ~2s. Respond first.
      return reply.code(202).send(result);
    } catch (err) {
      return reply.code(400).send({ error: "update_failed", message: String(err) });
    }
  });

  // --- Threads (renamed from conversations; old paths stay alive below) ---
  // Mutating routes use named handlers registered under BOTH paths: a 302
  // would make fetch re-issue them as GETs, dropping method + body. GET
  // aliases are plain 302s.
  const createThread = async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    const namespace = toUserNamespace(userId);
    metrics.conversationCreationsTotal.inc();
    // Spec §10: per-user concurrent-conversation cap. Delete old ones to free space.
    if (store.countConversations(namespace) >= maxConversationsPerUser) {
      metrics.conversationLimitReachedTotal.inc();
      return reply.code(503).send({ error: "conversation_limit_reached", limit: maxConversationsPerUser });
    }
    const body = CreateConversationBody.parse(req.body ?? {});
    // Spec §10: reject workspaces not on the allowlist (default-deny).
    if (body.workspace !== undefined && !workspaceAllowlist.isAllowed(body.workspace)) {
      metrics.workspaceRejectionsTotal.inc();
      return reply.code(400).send({ error: "workspace_not_allowed" });
    }
    const conv = store.createConversation({ ...body, namespace });
    return reply.code(201).send(conv);
  };
  app.post("/v1/threads", createThread);
  app.post("/v1/conversations", createThread);

  app.get("/v1/threads", async (req, reply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    const namespace = toUserNamespace(userId);
    return { conversations: store.listConversations(namespace) };
  });
  app.get("/v1/conversations", async (_req, reply) => reply.redirect("/v1/threads", 302));

  app.get("/v1/threads/:id", async (req, reply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    const namespace = toUserNamespace(userId);
    const { id } = req.params as { id: string };
    const conv = store.getConversation(id, namespace);
    return conv ? conv : reply.code(404).send({ error: "not_found" });
  });
  app.get("/v1/conversations/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.redirect(`/v1/threads/${id}`, 302);
  });

  const renameThread = async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    const namespace = toUserNamespace(userId);
    const { id } = req.params as { id: string };
    if (!store.getConversation(id, namespace)) return reply.code(404).send({ error: "not_found" });
    const body = RenameConversationBody.parse(req.body ?? {});
    store.renameConversation(id, namespace, body.title);
    return store.getConversation(id, namespace);
  };
  app.patch("/v1/threads/:id", renameThread);
  app.patch("/v1/conversations/:id", renameThread);

  const deleteThread = async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    const namespace = toUserNamespace(userId);
    const { id } = req.params as { id: string };
    // Cross-tenant guard: store.deleteConversation is namespaced, so a
    // foreign conv id is a no-op → 404, never a destructive 204.
    const deleted = store.deleteConversation(id, namespace);
    return deleted ? reply.code(204).send() : reply.code(404).send({ error: "not_found" });
  };
  app.delete("/v1/threads/:id", deleteThread);
  app.delete("/v1/conversations/:id", deleteThread);

  const promptThread = async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    const namespace = toUserNamespace(userId);
    // Spec §10: per-user rate limit. 429 with a Retry-After header.
    const remaining = rateLimiter.consume(userId);
    if (remaining < 0) {
      metrics.rateLimitedTotal.inc();
      return reply
        .code(429)
        .header("retry-after", "60")
        .send({ error: "rate_limited" });
    }
    const { id } = req.params as { id: string };
    const conv = store.getConversation(id, namespace);
    if (!conv) return reply.code(404).send({ error: "not_found" });
    const body = PromptBody.parse(req.body ?? {});
    // Spec §6/§10: workspace -> spawn cwd so pi finds its prior session file
    // on disk after a crash + re-prompt (session resume).
    const ok = await supervisor.prompt(
      id,
      body.message,
      body.streamingBehavior,
      { LAPIS_PROJECT_KEY: namespace },
      conv.workspace ?? undefined,
    );
    if (!ok) {
      metrics.promptRejections.inc();
      return reply.code(502).send({ error: "agent_rejected" });
    }
    metrics.promptRequestsTotal.inc();
    // Auto-title from the first prompt — the picker shows words, not uuids.
    if (conv.title === null) store.renameConversation(id, namespace, body.message.slice(0, 80));
    // Persist the user's prompt as an envelope so SSE replay reconstructs the
    // full conversation (assistant-only history was the "my chats are gone" bug).
    bus.publish({
      conversationId: id,
      ts: new Date().toISOString(),
      kind: "user_message",
      payload: { text: body.message },
    });
    return reply.code(202).send({ accepted: true });
  };
  app.post("/v1/threads/:id/prompt", promptThread);
  app.post("/v1/conversations/:id/prompt", promptThread);

  const abortThread = async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    const namespace = toUserNamespace(userId);
    const { id } = req.params as { id: string };
    if (!store.getConversation(id, namespace)) return reply.code(404).send({ error: "not_found" });
    await supervisor.abort(id);
    return reply.code(202).send({ accepted: true });
  };
  app.post("/v1/threads/:id/abort", abortThread);
  app.post("/v1/conversations/:id/abort", abortThread);

  // Spec interview + lifecycle (agent spec-centric UI, Slice 4). All blob
  // and status accessors are namespaced — cross-tenant ids 404 like every
  // other route.
  // Active spec sessions per thread; populated when the supervisor wires an
  // AgentContract into a spawned session. Absent entry = no live contract,
  // lifecycle routes persist the transition and skip the forwarding.
  const contracts = new Map<string, AgentContract>();

  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/v1/threads/:id/spec",
    async (req, reply) => {
      const userId = await user(req, reply);
      if (!userId) return;
      const namespace = toUserNamespace(userId);
      const { id } = req.params as { id: string };
      const parsed = PatchSpecBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
      }
      if (!store.getConversation(id, namespace)) return reply.code(404).send({ error: "not_found" });
      if (parsed.data.kind === "answer") {
        store.mergeSpecAnswers(id, namespace, parsed.data.answers);
      } else {
        store.patchSpecDraft(id, namespace, parsed.data.field, parsed.data.value);
      }
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>("/v1/threads/:id/approve", async (req, reply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    const namespace = toUserNamespace(userId);
    const { id } = req.params as { id: string };
    if (!store.getConversation(id, namespace)) return reply.code(404).send({ error: "not_found" });
    store.updateThreadStatus(id, namespace, "running");
    contracts.get(id)?.approve();
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/v1/threads/:id/abandon", async (req, reply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    const namespace = toUserNamespace(userId);
    const { id } = req.params as { id: string };
    if (!store.getConversation(id, namespace)) return reply.code(404).send({ error: "not_found" });
    store.updateThreadStatus(id, namespace, "abandoned");
    const contract = contracts.get(id);
    if (contract) contract.abandon();
    else supervisor.killChild(id); // no live contract: still stop the child
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/v1/threads/:id/retry", async (req, reply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    const namespace = toUserNamespace(userId);
    const { id } = req.params as { id: string };
    if (!store.getConversation(id, namespace)) return reply.code(404).send({ error: "not_found" });
    store.updateThreadStatus(id, namespace, "running");
    contracts.get(id)?.retry();
    return { ok: true };
  });

  app.get("/v1/conversations/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.redirect(`/v1/threads/${id}/events`, 302);
  });

  app.get("/v1/threads/:id/events", async (req, reply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    const namespace = toUserNamespace(userId);
    const { id } = req.params as { id: string };
    if (!store.getConversation(id, namespace)) return reply.code(404).send({ error: "not_found" });

    reply.hijack();
    // Hijacking the reply bypasses @fastify/cors reply hooks, so the streamed
    // response would go out with no Access-Control-Allow-Origin and the browser
    // would drop it (200 but unreadable). Mirror the plugin's allow-list logic.
    const origin = req.headers.origin;
    const headers: Record<string, string> = {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    };
    if (origin && opts.allowedOrigins?.includes(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers["access-control-allow-credentials"] = "true";
      headers["vary"] = "Origin";
    }
    reply.raw.writeHead(200, headers);
    reply.raw.write("retry: 2000\n\n");

    const raw = req.headers["last-event-id"];
    const parsed = Array.isArray(raw) ? Number(raw[0]) : Number(raw);
    let lastSeq = Number.isFinite(parsed) ? parsed : -1;

    const writeEnvelope = (env: EventEnvelope) => {
      if (env.seq <= lastSeq) return;
      lastSeq = env.seq;
      reply.raw.write(
        `id: ${env.seq}\nevent: ${env.kind}\ndata: ${JSON.stringify(env)}\n\n`,
      );
    };

    for (const env of bus.replay(id, lastSeq)) writeEnvelope(env);

    const unsubscribe = bus.subscribe(id, (env) => writeEnvelope(env));
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), opts.sseHeartbeatMs ?? 15_000);

    req.raw.on("close", () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
  });

  app.addHook("onClose", async () => {
    // Graceful shutdown: wait up to 5s for in-flight pi children to exit
    // before closing the store. Without this, a deploy during a turn kills
    // the child mid-prompt and the user sees a partial response.
    await supervisor.disposeAll();
    store.close();
  });

  return app;
}
