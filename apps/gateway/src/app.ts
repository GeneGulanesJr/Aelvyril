import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { spawn } from "node:child_process";
import {
  CreateConversationBody,
  EventEnvelope as EventEnvelopeSchema,
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
  /** Max total conversations per user (spec §10). #83 raised the default
   *  from 3 to 30: threads are cheap rows; the running-host cap below is
   *  the real resource limit. */
  maxConversationsPerUser?: number;
  /** #83: max concurrent running session hosts per user. Prompts beyond
   *  this are durably queued. Default 2. */
  maxRunningHostsPerUser?: number;
  /** #83: global ceiling on live session hosts across all users. Default 100. */
  maxSessionHosts?: number;
  /** #83: queue-runner tick interval in ms. Default 2_000 (tests shrink it). */
  queueIntervalMs?: number;
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
  /** Max concurrent SSE streams per user (security review #85). Default 10. */
  maxSseStreamsPerUser?: number;
  /** Replay events per SSE page; the client reconnects with Last-Event-ID to
   *  page through a long backlog. Default 500. */
  sseReplayPageSize?: number;
  /** Max events retained per conversation. Default 10_000 (0 disables). */
  eventRetentionPerThread?: number;
  /** Optional scrape secret for /metrics (#85). When set, requests must send
   *  `Authorization: Bearer <secret>`. Unset keeps /metrics open (the
   *  reverse proxy is expected to gate it). */
  metricsSecret?: string;
  /** #84: per-thread budget in USD. When a thread's cumulative cost reaches
   *  this, further prompts are refused with 403 cost_cap_reached. */
  maxCostPerThreadUsd?: number;
  /** #84: pi extension_ui_request handling. Default "auto-responder". */
  dialogMode?: "auto-responder" | "blocked";
  /** #76: user ids allowed to call /v1/admin/*. Default-deny: with no
   *  allowlist configured, /v1/admin/* answers 403 for everyone. */
  adminUserIds?: string[];
  /** Optional update-flow overrides for tests. Defaults run real git. */
  updateStatus?: typeof getUpdateStatus;
  /** Optional update-flow override for tests. Defaults to the real
   *  applyUpdate (spawns a detached restart script — never run in tests). */
  applyUpdate?: typeof applyUpdate;
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
    // #85: the client-supplied x-request-id flows into structured logs and
    // the response echo, so it is accepted only with a bounded safe charset
    // (and never trusted as a Fastify requestIdHeader). genReqId is called
    // for every request and applies the sanitization itself.
    genReqId: (req) => {
      const header = req.headers["x-request-id"];
      const raw = Array.isArray(header) ? header[0] : header;
      if (raw && /^[A-Za-z0-9_.:@-]{1,64}$/.test(raw)) return raw;
      return Math.random().toString(36).slice(2, 10);
    },
  });
  const store = new Store(opts.dbPath, {
    eventRetentionPerThread: opts.eventRetentionPerThread,
  });
  // #83: hosts die with the gateway process; rows still marked streaming
  // after a restart are stale. Queued prompts are durable and picked up
  // by the runner below, so recovery after a restart is automatic.
  store.markStaleStreamingDegraded();
  const bus = new EventBus(store);
  // Spec §10: default-deny workspace allowlist. Override via opts in tests.
  const workspaceAllowlist = opts.workspaceAllowlist ?? createWorkspaceAllowlist(process.env.GATEWAY_WORKSPACE_ALLOWLIST);
  // Spec §10: per-user rate limit on /v1/conversations/:id/prompt.
  // 20 requests/min = capacity 20, refill 20/60 tokens/sec.
  const rateLimiter = opts.rateLimiter ?? createRateLimiter({
    capacity: 20,
    refillPerSecond: 20 / 60,
  });
  // #83: the running-host cap is the real resource limit; the thread count
  // is not (rows are cheap). Defaults per the long-horizon execution issue.
  const maxConversationsPerUser = opts.maxConversationsPerUser ?? 30;
  const maxRunningHostsPerUser = opts.maxRunningHostsPerUser ?? 2;
  const maxSessionHosts = opts.maxSessionHosts ?? 100;
  // Security review #85: cap concurrent SSE streams per user (each holds a
  // bus listener + a heartbeat timer). Keyed by userId, counted on connect.
  const maxSseStreamsPerUser = opts.maxSseStreamsPerUser ?? 10;
  const sseStreams = new Map<string, number>();
  const sseReplayPageSize = opts.sseReplayPageSize ?? 500;
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
    maxCostPerThreadUsd: opts.maxCostPerThreadUsd,
    dialogMode: opts.dialogMode,
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

  // #76: /v1/admin/* is privileged — the update route restarts the process
  // and force-executes whatever lands on origin/main, so any authenticated
  // user (or stolen JWT) must NOT reach it. Allowlist via
  // GATEWAY_ADMIN_USER_IDS (Clerk Organizations admin wiring can slot in
  // later); default-deny when nothing is configured.
  const adminUserIds = new Set(opts.adminUserIds ?? []);
  async function admin(req: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
    const userId = await user(req, reply);
    if (!userId) return;
    if (!adminUserIds.has(userId)) {
      return void reply.code(403).send({ error: "forbidden" });
    }
    return userId;
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
    // #79: the gateway is an internal-only API (behind Caddy /v1/* in
    // prod) — responses are never framed and never MIME-sniffed. This
    // covers the helmet essentials without the dependency; CSP belongs
    // at the HTML-serving edge (the Caddyfile), not on JSON APIs.
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
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

  // Prometheus text format. Unauthenticated by design when no scrape secret
  // is configured (Prometheus scrapes internally; an external scraper should
  // go through the reverse proxy which gates /metrics on its own network
  // policy). #85: GATEWAY_METRICS_SECRET adds bearer-token gating for
  // deployments that expose the gateway directly.
  app.get("/metrics", async (req, reply) => {
    if (opts.metricsSecret) {
      const header = req.headers.authorization;
      if (header !== `Bearer ${opts.metricsSecret}`) {
        return reply.code(401).send({ error: "unauthorized" });
      }
    }
    reply.header("content-type", "text/plain; version=0.0.4");
    return metrics.render();
  });

  // Spec §11: manual update flow (#76: admin-gated — see the `admin` guard).
  // Self-hosted convenience for operators on the allowlist; check for +
  // apply upstream commits.
  app.get("/v1/admin/update/status", async (req, reply) => {
    const userId = await admin(req, reply);
    if (!userId) return;
    try {
      return await (opts.updateStatus ?? getUpdateStatus)();
    } catch (err) {
      return reply.code(503).send({ error: "update_status_failed", message: String(err) });
    }
  });

  app.post("/v1/admin/update", async (req, reply) => {
    const userId = await admin(req, reply);
    if (!userId) return;
    try {
      const result = await (opts.applyUpdate ?? applyUpdate)();
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
  // #85: the 302 aliases are authenticated like every other route (they
  // used to be open) and the reflected :id is charset-validated +
  // percent-encoded so it can't smuggle arbitrary header content.
  const threadIdOr400 = (rawId: string): string | undefined =>
    /^[A-Za-z0-9_-]{1,128}$/.test(rawId) ? encodeURIComponent(rawId) : undefined;

  app.get("/v1/conversations", async (req, reply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    return reply.redirect("/v1/threads", 302);
  });

  app.get("/v1/threads/:id", async (req, reply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    const namespace = toUserNamespace(userId);
    const { id } = req.params as { id: string };
    const conv = store.getConversation(id, namespace);
    return conv ? conv : reply.code(404).send({ error: "not_found" });
  });
  app.get("/v1/conversations/:id", async (req, reply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const safeId = threadIdOr400(id);
    if (!safeId) return reply.code(400).send({ error: "bad_request" });
    return reply.redirect(`/v1/threads/${safeId}`, 302);
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
    // #85: kill the session host too — otherwise it keeps running and its
    // next protocol event re-inserts orphan event rows for the deleted
    // conversation. killChild marks the id dead synchronously, so protocol
    // events already queued in the event loop are dropped as well. Only
    // after the namespaced delete succeeded: killChild is not namespaced.
    if (deleted) {
      supervisor.killChild(id);
      store.deleteQueuedForConversation(id);
    }
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
    // #84: budget enforcement — a thread at its cost cap needs explicit
    // operator action (raise GATEWAY_MAX_THREAD_COST_USD or abandon it).
    if (
      opts.maxCostPerThreadUsd !== undefined &&
      conv.usage &&
      conv.usage.cost >= opts.maxCostPerThreadUsd
    ) {
      metrics.costCapRejections.inc();
      return reply.code(403).send({
        error: "cost_cap_reached",
        cost: conv.usage.cost,
        cap: opts.maxCostPerThreadUsd,
      });
    }
    const body = PromptBody.parse(req.body ?? {});
    // Auto-title from the first prompt — the picker shows words, not uuids.
    if (conv.title === null) store.renameConversation(id, namespace, body.message.slice(0, 80));

    // #83: long-horizon execution. Steers target a live run and pass
    // through; a fresh prompt when the user is at their running-host cap
    // (or the global ceiling is hit) is durably queued instead — execution
    // is decoupled from any viewer.
    if (!body.streamingBehavior) {
      if (store.getThreadStatus(id, namespace) === "queued") {
        return reply.code(409).send({ error: "already_queued" });
      }
      const atUserCap = store.countStreaming(namespace) >= maxRunningHostsPerUser;
      const atGlobalCap = supervisor.runningCount() >= maxSessionHosts;
      if (atUserCap || atGlobalCap) {
        store.enqueuePrompt({ conversationId: id, namespace, message: body.message });
        store.updateThreadStatus(id, namespace, "queued");
        bus.publish({
          conversationId: id,
          ts: new Date().toISOString(),
          kind: "spec_status",
          payload: { status: "queued" },
        });
        // Persist the user's prompt so SSE replay reconstructs the
        // conversation even before the queued turn starts.
        bus.publish({
          conversationId: id,
          ts: new Date().toISOString(),
          kind: "user_message",
          payload: { text: body.message },
        });
        metrics.queuedPromptsTotal.inc();
        return reply.code(202).send({ accepted: true, queued: true });
      }
    }

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
        const merged = store.mergeSpecAnswers(id, namespace, parsed.data.answers);
        if (merged === "too_large") {
          return reply.code(413).send({ error: "spec_too_large" });
        }
      } else {
        const patched = store.patchSpecDraft(id, namespace, parsed.data.field, parsed.data.value);
        if (patched === "too_large") {
          return reply.code(413).send({ error: "spec_too_large" });
        }
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
    // #83 (2nd review): a queued prompt for an abandoned thread must not be
    // picked up by the runner later — abandoning is terminal.
    store.deleteQueuedForConversation(id);
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

  // #83: global kill switch — abandon is per-thread only today; this takes
  // down every live thread for the calling user in one shot, and drops
  // their queued work too.
  app.post("/v1/threads/kill-all", async (req, reply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    const namespace = toUserNamespace(userId);
    let abandoned = 0;
    for (const conv of store.listConversations(namespace)) {
      const status = store.getThreadStatus(conv.id, namespace);
      const live = conv.state === "streaming" || conv.state === "blocked";
      if (!live && status !== "queued") continue;
      supervisor.killChild(conv.id);
      store.updateThreadStatus(conv.id, namespace, "abandoned");
      store.setConversationState(conv.id, "idle");
      bus.publish({
        conversationId: conv.id,
        ts: new Date().toISOString(),
        kind: "spec_status",
        payload: { status: "abandoned" },
      });
      abandoned++;
    }
    store.deleteQueuedForNamespace(namespace);
    return { abandoned };
  });

  app.get("/v1/conversations/:id/events", async (req, reply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const safeId = threadIdOr400(id);
    if (!safeId) return reply.code(400).send({ error: "bad_request" });
    return reply.redirect(`/v1/threads/${safeId}/events`, 302);
  });

  app.get("/v1/threads/:id/events", async (req, reply) => {
    const userId = await user(req, reply);
    if (!userId) return;
    const namespace = toUserNamespace(userId);
    const { id } = req.params as { id: string };
    if (!store.getConversation(id, namespace)) return reply.code(404).send({ error: "not_found" });

    // Security review #85: per-user concurrent stream cap.
    const active = sseStreams.get(userId) ?? 0;
    if (active >= maxSseStreamsPerUser) {
      metrics.sseStreamsRejectedTotal.inc();
      return reply.code(429).send({ error: "too_many_streams" });
    }
    sseStreams.set(userId, active + 1);
    const releaseStream = () => {
      const n = (sseStreams.get(userId) ?? 1) - 1;
      if (n <= 0) sseStreams.delete(userId);
      else sseStreams.set(userId, n);
    };

    reply.hijack();
    // Handshake writes can hit an already-dead socket (client vanished
    // between auth and hijack). Fail the slot back before any listener
    // exists — an unguarded throw here leaks the stream slot and can
    // surface as an unhandled socket error.
    try {
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
    } catch {
      releaseStream();
      reply.raw.destroy();
      return reply;
    }

    const raw = req.headers["last-event-id"];
    const parsed = Array.isArray(raw) ? Number(raw[0]) : Number(raw);
    let lastSeq = Number.isFinite(parsed) ? parsed : -1;

    // Returns false when the envelope was skipped. Security review #85:
    // validate at the wire boundary — store rows are replayed unvalidated,
    // so legacy/malformed rows must not reach the stream (a kind containing
    // a newline would desync SSE framing). A failed write (EPIPE etc.)
    // returns false instead of throwing an unhandled socket error.
    const writeEnvelope = (env: EventEnvelope): boolean => {
      const parsed = EventEnvelopeSchema.safeParse(env);
      if (!parsed.success) return false;
      const valid = parsed.data;
      if (valid.seq <= lastSeq) return false;
      lastSeq = valid.seq;
      try {
        reply.raw.write(
          `id: ${valid.seq}\nevent: ${valid.kind}\ndata: ${JSON.stringify(valid)}\n\n`,
        );
      } catch {
        return false;
      }
      return true;
    };

    // Replay one page, then either hand the rest to a clean EOF (the web
    // client reconnects with Last-Event-ID and dedups by seq) or hold the
    // stream open for live events. Ending on a full page with zero valid
    // envelopes would loop the client on the same window, so fall through
    // to live subscription instead.
    const page = bus.replay(id, lastSeq, sseReplayPageSize);
    let written = 0;
    for (const env of page) {
      if (writeEnvelope(env)) written++;
    }
    if (page.length >= sseReplayPageSize && written > 0) {
      try {
        reply.raw.end();
      } catch {
        // socket already gone
      }
      releaseStream();
      return;
    }

    const unsubscribe = bus.subscribe(id, (env) => writeEnvelope(env));
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": ping\n\n");
      } catch {
        cleanup();
      }
    }, opts.sseHeartbeatMs ?? 15_000);
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(heartbeat);
      releaseStream();
    };
    // #85: the hijacked raw socket previously had no error handler — an
    // ECONNRESET mid-stream surfaced as an unhandled 'error' event.
    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);
    reply.raw.on("error", cleanup);
  });

  // #83: background queue runner. Pops durably queued prompts (FIFO per
  // namespace, fair across namespaces) whenever the user has a free
  // running-host slot. Execution is fully decoupled from any viewer: the
  // queue survives restarts and hosts spawn on demand via the supervisor.
  const queueTimer = setInterval(() => {
    try {
      for (const ns of store.listQueuedNamespaces()) {
        while (store.countStreaming(ns) < maxRunningHostsPerUser && supervisor.runningCount() < maxSessionHosts) {
          const item = store.dequeueOldestPrompt(ns);
          if (!item) break;
          const queued = store.getConversation(item.conversationId, ns);
          if (!queued) continue; // thread deleted while queued
          store.updateThreadStatus(item.conversationId, ns, "running");
          bus.publish({
            conversationId: item.conversationId,
            ts: new Date().toISOString(),
            kind: "spec_status",
            payload: { status: "running" },
          });
          void supervisor
            .prompt(
              item.conversationId,
              item.message,
              undefined,
              { LAPIS_PROJECT_KEY: ns },
              queued.workspace ?? undefined,
            )
            .then((ok) => {
              if (ok) {
                metrics.promptRequestsTotal.inc();
                return;
              }
              metrics.promptRejections.inc();
              try {
                store.setConversationState(item.conversationId, "degraded");
                store.updateThreadStatus(item.conversationId, ns, "reviewed");
                bus.publish({
                  conversationId: item.conversationId,
                  ts: new Date().toISOString(),
                  kind: "error",
                  payload: { message: "queued prompt was rejected by the agent" },
                });
              } catch {
                // store closed (shutdown); ignore
              }
            })
            .catch(() => {
              // prompt rejected at the rpc layer; already handled above
            });
        }
      }
    } catch {
      // store closed during shutdown; skip this tick
    }
  }, opts.queueIntervalMs ?? 2_000);
  queueTimer.unref();

  app.addHook("onClose", async () => {
    // Graceful shutdown: wait up to 5s for in-flight pi children to exit
    // before closing the store. Without this, a deploy during a turn kills
    // the child mid-prompt and the user sees a partial response.
    clearInterval(queueTimer);
    await supervisor.disposeAll();
    store.close();
  });

  return app;
}
